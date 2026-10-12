import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  createExamQuestions,
  gradeExam,
  sanitizeQuestions,
  validateQuestionBank,
  EXAM_BLUEPRINT,
  QUESTION_TYPE_LABELS,
} from "./src/exam-engine.js";
import { resultResponse as createResultResponse } from "./src/result-response.js";
import { gradeExamWithAi } from "./src/subjective-ai-grader.js";
import { AnswerCodeError, answerCodeView, createAnswerCode, redeemAnswerCode } from "./src/answer-codes.js";
import { AdminUserError, AdminUserStore, hasAdminPermission } from "./src/admin-users.js";
import { expirePendingPayment, paymentExpiresAt } from "./src/payment-lifecycle.js";
import { WechatPay, readWechatConfig, applyWechatTransaction } from "./src/wechat-pay.js";
import { ensureBlueprintCapacity, normalizeBlueprint, normalizeQuestion, questionBankSummary } from "./src/question-bank.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = path.join(ROOT, "data");
const BUNDLED_BANK_PATH = path.join(ROOT, "content", "question-bank.json");
const STATE_PATH = process.env.ONBOARDING_EXAM_STATE_PATH || path.join(DATA_DIR, "state.json");
const CONFIG_PATH = process.env.ONBOARDING_EXAM_CONFIG_PATH || path.join(DATA_DIR, "config.json");
const QUESTION_BANK_PATH = process.env.ONBOARDING_EXAM_QUESTION_BANK_PATH || path.join(DATA_DIR, "question-bank.json");
const ADMIN_USERS_PATH = process.env.ONBOARDING_EXAM_ADMIN_USERS_PATH || path.join(DATA_DIR, "admin-users.json");
const DEFAULT_QR_PATH = path.join(PUBLIC_DIR, "payment-qr.svg");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const RELEASE_REVISION = process.env.RELEASE_REVISION || "development";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const DEMO_AUTO_PAY = process.env.DEMO_AUTO_PAY === "1";
const wechatPay = new WechatPay(readWechatConfig());
const prepayRequests = new Map();
const queryRequests = new Map();
const lastPaymentQuery = new Map();
const DEFAULT_EXAM_MINUTES = 18;
const MIN_EXAM_MINUTES = 1;
const MAX_EXAM_MINUTES = 180;
const EXAM_SUBMIT_GRACE_MS = 60_000;

const defaultConfig = {
  clubName: "机枪纯女电竞",
  examTitle: "俱乐部入职文考",
  passScore: 85,
  maxAttempts: 6,
  examMinutes: DEFAULT_EXAM_MINUTES,
  paymentInstructions: "请按页面显示金额扫码付款，付款后等待管理员确认。",
  contactText: "付款后请保留支付凭证。",
  qrFile: "",
  blueprint: EXAM_BLUEPRINT,
  scorePolicy: "highest",
};

fs.mkdirSync(DATA_DIR, { recursive: true });

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return structuredClone(fallback);
  }
}

function writeJson(filePath, value) {
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tempPath, filePath);
}

const bundledBank = readJson(BUNDLED_BANK_PATH, null);
let config = { ...defaultConfig, ...(bundledBank?.examConfig || {}), ...readJson(CONFIG_PATH, {}) };
config.blueprint = { ...EXAM_BLUEPRINT, ...(config.blueprint || {}) };
config.examMinutes = normalizeExamMinutes(config.examMinutes);
let state = readJson(STATE_PATH, {
  payments: [],
  exams: [],
  results: [],
  certificates: [],
  answerCodes: [],
});
state.answerCodes = Array.isArray(state.answerCodes) ? state.answerCodes : [];
let questionBank = readJson(QUESTION_BANK_PATH, null);
if (!questionBank && !process.env.ONBOARDING_EXAM_QUESTION_BANK_PATH && bundledBank) {
  questionBank = structuredClone(bundledBank);
  writeJson(QUESTION_BANK_PATH, questionBank);
}
if (!questionBank) throw new Error("缺少 data/question-bank.json，请先运行题库导入脚本。 ");
validateQuestionBank(questionBank, config.blueprint);

let adminUserStore = null;
const adminSessions = new Map();
const answerCodeFailures = new Map();

function getAdminUsers() {
  if (!adminUserStore) adminUserStore = new AdminUserStore({ filePath: ADMIN_USERS_PATH, seedPassword: ADMIN_PASSWORD });
  return adminUserStore;
}

function nowIso() {
  return new Date().toISOString();
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function id(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${randomToken(7)}`;
}

function candidateKey(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, "");
}

function cleanText(value, maxLength = 80) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeExamMinutes(value) {
  const minutes = Number(value);
  return Number.isInteger(minutes) && minutes >= MIN_EXAM_MINUTES && minutes <= MAX_EXAM_MINUTES
    ? minutes
    : DEFAULT_EXAM_MINUTES;
}

function requestAddress(request) {
  return String(request.headers["x-forwarded-for"] || request.socket.remoteAddress || "unknown").split(",")[0].trim();
}

function answerCodeRateLimited(request, now = Date.now()) {
  const key = requestAddress(request);
  const entry = answerCodeFailures.get(key);
  if (!entry || entry.resetAt <= now) {
    answerCodeFailures.delete(key);
    return false;
  }
  return entry.count >= 10;
}

function registerAnswerCodeFailure(request, now = Date.now()) {
  const key = requestAddress(request);
  const current = answerCodeFailures.get(key);
  if (!current || current.resetAt <= now) answerCodeFailures.set(key, { count: 1, resetAt: now + 10 * 60_000 });
  else current.count += 1;
}

function clearAnswerCodeFailures(request) {
  answerCodeFailures.delete(requestAddress(request));
}

function attemptsFor(key) {
  return state.exams.filter((exam) => exam.candidateKey === key).length;
}

function feeForAttempt(attemptNumber) {
  return attemptNumber === 1 ? 0 : attemptNumber === 2 ? 20 : 30;
}

function paymentResponse(payment) {
  return {
    id: payment.id,
    token: payment.token,
    candidateName: payment.candidateName,
    candidateId: payment.candidateId,
    amount: payment.amount,
    attemptNumber: payment.attemptNumber,
    status: payment.status,
    createdAt: payment.createdAt,
    confirmedAt: payment.confirmedAt || null,
    examId: payment.examId || null,
    paymentChannel: payment.paymentChannel || null,
    nativeOrderCreated: Boolean(payment.nativePrepayRequestedAt),
    codeUrl: payment.codeUrl || null,
    wechatTransactionId: payment.wechatTransactionId || null,
    paidAt: payment.paidAt || null,
    expiresAt: new Date(paymentExpiresAt(payment)).toISOString(),
    canceledAt: payment.canceledAt || null,
    cancelReason: payment.cancelReason || null,
  };
}

async function reconcileWechatPayment(payment, { force = false } = {}) {
  if (!wechatPay.status.ready || payment.paymentChannel !== "wechat_native" || !payment.nativePrepayRequestedAt || payment.status === "paid") return;
  if (queryRequests.has(payment.id)) return queryRequests.get(payment.id);
  if (!force && Date.now() - (lastPaymentQuery.get(payment.id) || 0) < 10_000) return;
  const task = (async () => {
    lastPaymentQuery.set(payment.id, Date.now());
    try {
      const transaction = await wechatPay.query(payment.paymentNo);
      if (applyWechatTransaction(wechatPay, transaction, payment)) saveState();
    } catch (error) {
      if (error.code !== "ORDER_NOT_EXIST" && force) throw error;
    }
  })();
  queryRequests.set(payment.id, task);
  try { await task; } finally { queryRequests.delete(payment.id); }
}

async function createNativePrepay(payment) {
  if (!wechatPay.status.ready) throw new Error("微信收款尚未开通，请联系考官或使用答题码");
  if (prepayRequests.has(payment.id)) return prepayRequests.get(payment.id);
  const task = (async () => {
    if (payment.codeUrl) return paymentResponse(payment);
    if (payment.nativePrepayRequestedAt) await reconcileWechatPayment(payment, { force: true });
    if (payment.status === "paid") return paymentResponse(payment);
    if (payment.status !== "pending" || paymentExpiresAt(payment) - Date.now() < 60_000) throw new Error("付款单已临近到期，请稍后重新报名");
    payment.paymentChannel = "wechat_native";
    payment.nativePrepayRequestedAt = nowIso();
    saveState(); // Persist before networking so a timeout or restart can be recovered by querying.
    const codeUrl = await wechatPay.prepay(payment, `${config.clubName}${config.examTitle}第${payment.attemptNumber}次`);
    if (payment.status === "paid") return paymentResponse(payment);
    if (payment.status !== "pending" || expirePendingPayment(payment)) {
      saveState();
      throw new Error("付款单已取消，请重新报名");
    }
    payment.codeUrl = codeUrl;
    saveState();
    return paymentResponse(payment);
  })();
  prepayRequests.set(payment.id, task);
  try { return await task; } finally { prepayRequests.delete(payment.id); }
}

async function closeCanceledNativePayment(payment) {
  if (payment.status !== "canceled" || !payment.nativePrepayRequestedAt) return;
  try { await wechatPay.close(payment.paymentNo); }
  catch (error) {
    if (error.code === "ORDER_NOT_EXIST" || error.code === "ORDERCLOSED") return;
    if (error.code === "ORDERPAID") {
      await reconcileWechatPayment(payment, { force: true });
      if (payment.status === "paid") return;
    }
    throw error;
  }
}

async function handleWechatNotify(headers, rawBody) {
  const transaction = wechatPay.notification(headers, rawBody);
  const payment = state.payments.find((item) => item.paymentNo === transaction.out_trade_no);
  if (!payment) throw new Error("付款单不存在");
  if (applyWechatTransaction(wechatPay, transaction, payment)) saveState();
}

function promoteDemoPayment(payment) {
  if (DEMO_AUTO_PAY && payment.status === "pending") {
    payment.status = "paid";
    payment.confirmedAt = payment.confirmedAt || nowIso();
    saveState();
  }
  return payment;
}

function saveState() {
  writeJson(STATE_PATH, state);
}

function saveConfig() {
  writeJson(CONFIG_PATH, config);
}

function saveQuestionBank() {
  questionBank.updatedAt = nowIso();
  writeJson(QUESTION_BANK_PATH, questionBank);
}

function expirePendingPayments(now = Date.now()) {
  let changed = false;
  for (const payment of state.payments) {
    if (expirePendingPayment(payment, now)) {
      changed = true;
    } else if (payment.status === "pending" && payment.amount !== feeForAttempt(payment.attemptNumber)) {
      payment.status = "canceled";
      payment.canceledAt = new Date(now).toISOString();
      payment.cancelReason = "fee_policy_changed";
      payment.codeUrl = null;
      changed = true;
    }
  }
  if (changed) saveState();
  return changed;
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function sendError(response, status, message) {
  sendJson(response, status, { error: message });
}

function readBody(request, maxBytes = 3_000_000) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > maxBytes) {
        reject(new Error("请求内容过大"));
        request.destroy();
      }
    });
    request.on("end", () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error("请求格式错误"));
      }
    });
    request.on("error", reject);
  });
}

function readRawBody(request, maxBytes = 3_000_000) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > maxBytes) {
        reject(new Error("请求内容过大"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function bearerToken(request) {
  const header = request.headers.authorization || "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

function requireAdmin(request, response) {
  const token = bearerToken(request);
  const session = adminSessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    adminSessions.delete(token);
    sendError(response, 401, "管理员登录已失效");
    return null;
  }
  const user = getAdminUsers().getById(session.userId);
  if (!user?.active) {
    adminSessions.delete(token);
    sendError(response, 401, "管理员账号不存在或已停用");
    return null;
  }
  return user;
}

function requireAdminPermission(request, response, permission) {
  const user = requireAdmin(request, response);
  if (!user) return null;
  if (!hasAdminPermission(user, permission)) {
    sendError(response, 403, "当前管理员没有此功能权限");
    return null;
  }
  return user;
}

function revokeAdminSessions(userId) {
  for (const [token, session] of adminSessions) {
    if (session.userId === userId) adminSessions.delete(token);
  }
}

function publicConfig() {
  return {
    clubName: config.clubName,
    examTitle: config.examTitle,
    passScore: config.passScore,
    maxAttempts: config.maxAttempts,
    feeSchedule: Array.from({ length: config.maxAttempts }, (_, index) => feeForAttempt(index + 1)),
    feePolicy: "每位考生按个人考核次数付费：首次免费，第二次 20 元，第三次起每次 30 元。考费全部归考官。",
    examMinutes: config.examMinutes,
    totalScore: 100,
    scorePolicy: config.scorePolicy,
    multipleChoiceScoring: "多选全对才得分，多选、少选、错选均不得分。",
    paymentInstructions: "请用微信扫描本次订单二维码，付款成功后系统自动确认。请在 30 分钟内完成付款。",
    paymentMode: "wechat_native",
    nativePayReady: wechatPay.status.ready,
    contactText: config.contactText,
    demoAutoPay: DEMO_AUTO_PAY,
    blueprint: Object.entries(config.blueprint).map(([type, count]) => ({
      type,
      label: QUESTION_TYPE_LABELS[type],
      count,
      points: [...new Set(questionBank.questions.filter((question) => question.type === type && question.enabled !== false).map((question) => question.points))].length === 1
        ? questionBank.questions.find((question) => question.type === type && question.enabled !== false)?.points : null,
    })),
  };
}

function createOrUpdateCertificate(result) {
  const existing = state.certificates.find((certificate) => certificate.resultId === result.id);
  if (!result.passed) {
    if (existing) state.certificates = state.certificates.filter((certificate) => certificate.id !== existing.id);
    result.certificateId = null;
    return null;
  }
  if (existing) {
    existing.score = result.finalScore;
    existing.updatedAt = nowIso();
    result.certificateId = existing.id;
    return existing;
  }
  const certificate = {
    id: `JQ-${new Date().getFullYear()}-${crypto.randomInt(100000, 999999)}`,
    resultId: result.id,
    candidateKey: result.candidateKey,
    candidateName: result.candidateName,
    candidateId: result.candidateId,
    score: result.finalScore,
    issuedAt: nowIso(),
  };
  state.certificates.push(certificate);
  result.certificateId = certificate.id;
  return certificate;
}

function highestResult(key) {
  return state.results.filter((result) => result.candidateKey === key)
    .reduce((best, result) => !best || result.finalScore > best.finalScore ? result : best, null);
}

const resultResponse = (result, detailLevel = "none") => {
  const highest = highestResult(result.candidateKey) || result;
  return {
    ...createResultResponse(result, detailLevel, config.passScore),
    highestScore: highest.finalScore,
    highestPassed: highest.finalScore >= config.passScore,
    highestCertificateId: highest.certificateId || null,
  };
};

function localDayKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dashboardData(currentUser) {
  const canViewPayments = hasAdminPermission(currentUser, "payments");
  const canViewResults = hasAdminPermission(currentUser, "results");
  const canViewCodes = hasAdminPermission(currentUser, "answer_codes");
  const now = new Date();
  const todayKey = localDayKey(now);
  const paidPayments = state.payments.filter((payment) => payment.status === "paid" && Number(payment.amount) > 0);
  const totalRevenue = paidPayments.reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const todayRevenue = paidPayments
    .filter((payment) => localDayKey(payment.confirmedAt || payment.paidAt || payment.createdAt) === todayKey)
    .reduce((sum, payment) => sum + Number(payment.amount || 0), 0);
  const submittedToday = state.results.filter((result) => localDayKey(result.submittedAt) === todayKey).length;
  const averageScore = state.results.length
    ? Number((state.results.reduce((sum, result) => sum + Number(result.finalScore || 0), 0) / state.results.length).toFixed(1))
    : 0;
  const passed = state.results.filter((result) => result.passed).length;
  const days = Array.from({ length: 7 }, (_, offset) => {
    const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (6 - offset));
    const key = localDayKey(date);
    return {
      key,
      label: `${date.getMonth() + 1}/${date.getDate()}`,
      revenue: canViewPayments ? paidPayments
        .filter((payment) => localDayKey(payment.confirmedAt || payment.paidAt || payment.createdAt) === key)
        .reduce((sum, payment) => sum + Number(payment.amount || 0), 0) : null,
      submissions: canViewResults ? state.results.filter((result) => localDayKey(result.submittedAt) === key).length : null,
    };
  });
  const channelMap = new Map([
    ["wechat_native", { key: "wechat_native", label: "微信 Native", count: 0, revenue: 0 }],
    ["manual", { key: "manual", label: "人工确认", count: 0, revenue: 0 }],
    ["answer_code", { key: "answer_code", label: "答题码计入", count: 0, revenue: 0 }],
  ]);
  for (const payment of paidPayments) {
    const key = payment.paymentChannel === "wechat_native" ? "wechat_native" : payment.paymentChannel === "answer_code" ? "answer_code" : "manual";
    const item = channelMap.get(key);
    item.count += 1;
    item.revenue += Number(payment.amount || 0);
  }
  const activeAnswerCodes = state.answerCodes.filter((answerCode) => answerCodeView(answerCode).effectiveStatus === "active").length;
  return {
    stats: {
      pendingPayments: canViewPayments ? state.payments.filter((payment) => payment.status === "pending").length : null,
      paidPayments: canViewPayments ? paidPayments.length : null,
      totalRevenue: canViewPayments ? totalRevenue : null,
      todayRevenue: canViewPayments ? todayRevenue : null,
      totalExams: canViewResults ? state.exams.length : null,
      activeExams: canViewResults ? state.exams.filter((exam) => exam.status === "active").length : null,
      submittedToday: canViewResults ? submittedToday : null,
      averageScore: canViewResults ? averageScore : null,
      passed: canViewResults ? passed : null,
      passRate: canViewResults && state.results.length ? Number(((passed / state.results.length) * 100).toFixed(1)) : canViewResults ? 0 : null,
      certificates: canViewResults ? state.certificates.length : null,
      activeAnswerCodes: canViewCodes ? activeAnswerCodes : null,
      questionCount: hasAdminPermission(currentUser, "questions") ? questionBank.questions.length : null,
    },
    analytics: {
      days,
      paymentChannels: canViewPayments ? [...channelMap.values()] : [],
      resultBreakdown: canViewResults ? { passed, failed: state.results.length - passed } : null,
    },
  };
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    return sendJson(response, 200, { ok: true, service: "jqcn-exam", revision: RELEASE_REVISION });
  }
  if (request.method === "GET" && url.pathname === "/api/config") {
    return sendJson(response, 200, publicConfig());
  }

  if (request.method === "GET" && url.pathname === "/api/payment-qr") {
    const qrPath = config.qrFile && fs.existsSync(config.qrFile) ? config.qrFile : DEFAULT_QR_PATH;
    const extension = path.extname(qrPath).toLowerCase();
    const types = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml" };
    response.writeHead(200, { "Content-Type": types[extension] || "application/octet-stream", "Cache-Control": "no-store" });
    return fs.createReadStream(qrPath).pipe(response);
  }

  if (request.method === "POST" && url.pathname === "/api/candidate/status") {
    expirePendingPayments();
    const body = await readBody(request);
    const key = candidateKey(body.candidateId);
    if (!key) return sendError(response, 400, "请输入东东数字ID");
    const used = attemptsFor(key);
    const pendingPayment = state.payments
      .filter((payment) => payment.candidateKey === key && ["pending", "paid"].includes(payment.status) && !payment.usedAt)
      .at(-1);
    return sendJson(response, 200, {
      attemptsUsed: used,
      attemptsRemaining: Math.max(0, config.maxAttempts - used),
      nextAttempt: used + 1,
      nextFee: used < config.maxAttempts ? feeForAttempt(used + 1) : null,
      highestScore: highestResult(key)?.finalScore ?? null,
      pendingPayment: pendingPayment ? paymentResponse(pendingPayment) : null,
    });
  }

  if (request.method === "POST" && url.pathname === "/api/answer-codes/redeem") {
    if (answerCodeRateLimited(request)) return sendError(response, 429, "答题码尝试次数过多，请 10 分钟后再试");
    const body = await readBody(request);
    const candidateName = cleanText(body.candidateName, 30);
    const candidateId = cleanText(body.candidateId, 50);
    const contact = cleanText(body.contact, 50);
    const key = candidateKey(candidateId);
    if (candidateName.length < 2) return sendError(response, 400, "请输入真实姓名或入职昵称");
    if (!key) return sendError(response, 400, "请输入东东数字ID");
    if (!cleanText(body.code, 40)) return sendError(response, 400, "请输入答题码");
    const used = attemptsFor(key);
    if (used >= config.maxAttempts) return sendError(response, 403, `${config.maxAttempts} 次考试机会已全部使用`);

    for (const native of state.payments.filter((item) => item.candidateKey === key && item.nativePrepayRequestedAt && !item.usedAt && item.status !== "paid")) {
      try {
        await reconcileWechatPayment(native, { force: true });
        if (native.status === "paid") continue;
        native.status = "canceled";
        native.cancelReason = "answer_code_used";
        native.canceledAt ||= nowIso();
        native.codeUrl = null;
        saveState();
        await closeCanceledNativePayment(native);
      } catch { return sendError(response, 503, "正在核对微信订单，请稍后再使用答题码"); }
    }

    const existingPaid = state.payments
      .filter((payment) => payment.candidateKey === key && payment.status === "paid" && !payment.usedAt)
      .at(-1);
    if (existingPaid) return sendJson(response, 200, paymentResponse(existingPaid));
    for (const pending of state.payments.filter((payment) => payment.candidateKey === key && payment.status === "pending" && !payment.usedAt)) {
      pending.status = "canceled";
      pending.canceledAt = nowIso();
      pending.cancelReason = "answer_code_used";
      pending.codeUrl = null;
    }

    try {
      const redeemed = redeemAnswerCode(state.answerCodes, { code: body.code, candidateKey: key, candidateName, candidateId });
      const createdAt = nowIso();
      const payment = {
        id: id("pay"),
        paymentNo: `CODE${Date.now()}${crypto.randomBytes(4).toString("hex").toUpperCase()}`.slice(0, 32),
        token: randomToken(),
        candidateKey: key,
        candidateName,
        candidateId,
        contact,
        amount: redeemed.answerCode.countAsRevenue ? feeForAttempt(used + 1) : 0,
        attemptNumber: used + 1,
        status: "paid",
        createdAt,
        confirmedAt: createdAt,
        paidAt: createdAt,
        usedAt: null,
        examId: null,
        paymentChannel: "answer_code",
        answerCodeId: redeemed.answerCode.id,
        revenueCounted: redeemed.answerCode.countAsRevenue === true,
      };
      redeemed.redemption.paymentId = payment.id;
      state.payments.push(payment);
      saveState();
      clearAnswerCodeFailures(request);
      return sendJson(response, 201, paymentResponse(payment));
    } catch (error) {
      if (error instanceof AnswerCodeError) {
        registerAnswerCodeFailure(request);
        return sendError(response, error.status, error.message);
      }
      throw error;
    }
  }

  if (request.method === "POST" && url.pathname === "/api/payment/request") {
    expirePendingPayments();
    const body = await readBody(request);
    const candidateName = cleanText(body.candidateName, 30);
    const candidateId = cleanText(body.candidateId, 50);
    const contact = cleanText(body.contact, 50);
    const key = candidateKey(candidateId);
    if (candidateName.length < 2) return sendError(response, 400, "请输入真实姓名或入职昵称");
    if (!key) return sendError(response, 400, "请输入东东数字ID");

    const used = attemptsFor(key);
    if (used >= config.maxAttempts) return sendError(response, 403, `${config.maxAttempts} 次考试机会已全部使用`);
    const attemptNumber = used + 1;
    const amount = feeForAttempt(attemptNumber);
    const priorNative = state.payments.filter((item) => item.candidateKey === key && item.nativePrepayRequestedAt && !item.usedAt && item.status !== "paid").at(-1);
    if (priorNative) {
      try {
        await reconcileWechatPayment(priorNative, { force: true });
        await closeCanceledNativePayment(priorNative);
      }
      catch { return sendError(response, 503, "正在核对上一笔微信订单，请稍后重试"); }
    }
    const existing = state.payments
      .filter((payment) => payment.candidateKey === key && ["pending", "paid"].includes(payment.status) && !payment.usedAt)
      .at(-1);
    if (existing) {
      if (existing.status === "paid" || (existing.amount === amount && existing.attemptNumber === attemptNumber)) {
        return sendJson(response, 200, paymentResponse(promoteDemoPayment(existing)));
      }
      existing.status = "canceled";
      existing.canceledAt = nowIso();
      existing.cancelReason = "fee_policy_changed";
      existing.codeUrl = null;
    }

    const confirmed = amount === 0 || DEMO_AUTO_PAY;
    const payment = {
      id: id("pay"),
      paymentNo: `JQCNE${Date.now()}${crypto.randomBytes(4).toString("hex").toUpperCase()}`.slice(0, 32),
      token: randomToken(),
      candidateKey: key,
      candidateName,
      candidateId,
      contact,
      amount,
      attemptNumber,
      status: confirmed ? "paid" : "pending",
      paymentChannel: amount === 0 ? "free" : "wechat_native",
      createdAt: nowIso(),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      confirmedAt: confirmed ? nowIso() : null,
      usedAt: null,
      examId: null,
    };
    state.payments.push(payment);
    saveState();
    return sendJson(response, 201, paymentResponse(payment));
  }

  if (request.method === "POST" && url.pathname === "/api/payment/native-prepay") {
    expirePendingPayments();
    const body = await readBody(request);
    const payment = state.payments.find((item) => item.token === body.token);
    if (!payment) return sendError(response, 404, "付款申请不存在");
    if (expirePendingPayment(payment)) {
      saveState();
      return sendError(response, 409, "付款申请已超时取消，请重新发起");
    }
    if (payment.status === "canceled") return sendError(response, 409, "付款申请已取消，请重新发起");
    if (payment.status === "paid") return sendJson(response, 200, paymentResponse(payment));
    try {
      return sendJson(response, 200, await createNativePrepay(payment));
    } catch (error) {
      return sendError(response, 503, error.message || "Native 支付暂不可用");
    }
  }

  if (request.method === "POST" && url.pathname === "/api/payment/wechat-notify") {
    const rawBody = await readRawBody(request);
    try {
      await handleWechatNotify(request.headers, rawBody);
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      return response.end(JSON.stringify({ code: "SUCCESS", message: "成功" }));
    } catch (error) {
      console.error("[native-pay] notify failed", error);
      return sendError(response, 400, "支付通知处理失败");
    }
  }

  if (request.method === "GET" && url.pathname.startsWith("/api/payment/status/")) {
    expirePendingPayments();
    const token = url.pathname.split("/").at(-1);
    const payment = state.payments.find((item) => item.token === token);
    if (!payment) return sendError(response, 404, "付款申请不存在");
    await reconcileWechatPayment(payment);
    if (expirePendingPayment(payment)) saveState();
    return sendJson(response, 200, paymentResponse(promoteDemoPayment(payment)));
  }

  if (request.method === "POST" && url.pathname === "/api/exams/start") {
    const body = await readBody(request);
    const payment = state.payments.find((item) => item.token === body.paymentToken);
    if (!payment) return sendError(response, 404, "付款申请不存在");
    if (payment.status !== "paid") return sendError(response, 403, "付款尚未确认");

    if (payment.examId) {
      const existingExam = state.exams.find((exam) => exam.id === payment.examId);
      if (existingExam) {
        return sendJson(response, 200, {
          id: existingExam.id,
          accessToken: existingExam.accessToken,
          expiresAt: existingExam.expiresAt,
          status: existingExam.status,
        });
      }
    }

    const used = attemptsFor(payment.candidateKey);
    if (used >= config.maxAttempts) return sendError(response, 403, `${config.maxAttempts} 次考试机会已全部使用`);
    const createdAt = nowIso();
    const previousQuestionIds = state.exams
      .filter((item) => item.candidateKey === payment.candidateKey)
      .flatMap((item) => item.questions.map((question) => question.id));
    const exam = {
      id: id("exam"),
      accessToken: randomToken(),
      paymentId: payment.id,
      candidateKey: payment.candidateKey,
      candidateName: payment.candidateName,
      candidateId: payment.candidateId,
      attemptNumber: used + 1,
      questions: createExamQuestions(questionBank, config.blueprint, { previousQuestionIds }),
      createdAt,
      expiresAt: new Date(Date.now() + config.examMinutes * 60_000).toISOString(),
      status: "active",
      submittedAt: null,
      resultId: null,
    };
    state.exams.push(exam);
    payment.usedAt = createdAt;
    payment.examId = exam.id;
    saveState();
    return sendJson(response, 201, {
      id: exam.id,
      accessToken: exam.accessToken,
      expiresAt: exam.expiresAt,
      status: exam.status,
    });
  }

  const examMatch = url.pathname.match(/^\/api\/exams\/([^/]+)$/);
  if (request.method === "GET" && examMatch) {
    const exam = state.exams.find((item) => item.id === examMatch[1] && item.accessToken === url.searchParams.get("token"));
    if (!exam) return sendError(response, 404, "考试不存在或访问凭证无效");
    if (exam.status === "submitted") {
      const result = state.results.find((item) => item.id === exam.resultId);
      return sendJson(response, 200, { status: exam.status, result: resultResponse(result, "candidate") });
    }
    return sendJson(response, 200, {
      id: exam.id,
      candidateName: exam.candidateName,
      candidateId: exam.candidateId,
      attemptNumber: exam.attemptNumber,
      expiresAt: exam.expiresAt,
      status: exam.status,
      questions: sanitizeQuestions(exam.questions),
    });
  }

  const submitMatch = url.pathname.match(/^\/api\/exams\/([^/]+)\/submit$/);
  if (request.method === "POST" && submitMatch) {
    const body = await readBody(request);
    const exam = state.exams.find((item) => item.id === submitMatch[1] && item.accessToken === body.accessToken);
    if (!exam) return sendError(response, 404, "考试不存在或访问凭证无效");
    if (exam.status === "submitted") {
      const existingResult = state.results.find((item) => item.id === exam.resultId);
      return sendJson(response, 200, resultResponse(existingResult, "candidate"));
    }

    if (Date.now() > new Date(exam.expiresAt).getTime() + EXAM_SUBMIT_GRACE_MS) {
      return sendError(response, 403, "考试时间已结束，请重新查看考试状态");
    }

    let graded;
    try {
      graded = await gradeExamWithAi(exam.questions, body.answers || {});
    } catch (error) {
      console.error("[exam-submit] grading failed; using local fallback", error);
      graded = gradeExam(exam.questions, body.answers || {});
    }
    const result = {
      id: id("result"),
      examId: exam.id,
      candidateKey: exam.candidateKey,
      candidateName: exam.candidateName,
      candidateId: exam.candidateId,
      attemptNumber: exam.attemptNumber,
      automaticScore: graded.score,
      finalScore: graded.score,
      passed: graded.score >= config.passScore,
      details: graded.details,
      submittedAt: nowIso(),
      reviewNote: "",
      certificateId: null,
    };
    createOrUpdateCertificate(result);
    state.results.push(result);
    exam.status = "submitted";
    exam.submittedAt = result.submittedAt;
    exam.resultId = result.id;
    saveState();
    return sendJson(response, 201, resultResponse(result, "candidate"));
  }

  const resultMatch = url.pathname.match(/^\/api\/results\/([^/]+)$/);
  if (request.method === "GET" && resultMatch) {
    const result = state.results.find((item) => item.id === resultMatch[1]);
    if (!result) return sendError(response, 404, "成绩不存在");
    const exam = state.exams.find((item) => item.id === result.examId);
    if (!exam || exam.accessToken !== url.searchParams.get("token")) return sendError(response, 403, "无权查看该成绩");
    return sendJson(response, 200, resultResponse(result, "candidate"));
  }

  const certificateMatch = url.pathname.match(/^\/api\/certificates\/([^/]+)$/);
  if (request.method === "GET" && certificateMatch) {
    const certificate = state.certificates.find((item) => item.id === decodeURIComponent(certificateMatch[1]));
    if (!certificate) return sendError(response, 404, "证明不存在或已失效");
    return sendJson(response, 200, {
      ...certificate,
      clubName: config.clubName,
      examTitle: config.examTitle,
      passScore: config.passScore,
      valid: true,
    });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/login") {
    const body = await readBody(request);
    const user = getAdminUsers().authenticate(body.username, body.password);
    if (!user) return sendError(response, 401, "用户名或密码错误");
    const token = randomToken();
    adminSessions.set(token, { userId: user.id, expiresAt: Date.now() + 12 * 60 * 60_000 });
    return sendJson(response, 200, { token, user });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/logout") {
    adminSessions.delete(bearerToken(request));
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/admin/dashboard") {
    const currentUser = requireAdmin(request, response);
    if (!currentUser) return;
    expirePendingPayments();
    const canViewPayments = hasAdminPermission(currentUser, "payments");
    const canViewResults = hasAdminPermission(currentUser, "results");
    const overview = dashboardData(currentUser);
    return sendJson(response, 200, {
      currentUser,
      config: publicConfig(),
      payments: canViewPayments ? state.payments.slice(-100).reverse().map(paymentResponse) : [],
      results: canViewResults ? state.results.slice(-100).reverse().map((result) => resultResponse(result)) : [],
      adminUsers: currentUser.role === "owner" ? getAdminUsers().list() : [],
      stats: overview.stats,
      analytics: overview.analytics,
    });
  }

  if (request.method === "GET" && url.pathname === "/api/admin/users") {
    const currentUser = requireAdmin(request, response);
    if (!currentUser) return;
    if (currentUser.role !== "owner") return sendError(response, 403, "仅所有者可以管理管理员账号");
    return sendJson(response, 200, { users: getAdminUsers().list() });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/users") {
    const currentUser = requireAdmin(request, response);
    if (!currentUser) return;
    const body = await readBody(request);
    const user = getAdminUsers().create(body, currentUser.id);
    return sendJson(response, 201, { user });
  }

  const adminUserMatch = url.pathname.match(/^\/api\/admin\/users\/([^/]+)$/);
  if (request.method === "PATCH" && adminUserMatch) {
    const currentUser = requireAdmin(request, response);
    if (!currentUser) return;
    const body = await readBody(request);
    const user = getAdminUsers().update(adminUserMatch[1], body, currentUser.id);
    if (body.active === false || body.password) revokeAdminSessions(user.id);
    return sendJson(response, 200, { user });
  }

  if (request.method === "DELETE" && adminUserMatch) {
    const currentUser = requireAdmin(request, response);
    if (!currentUser) return;
    const user = getAdminUsers().remove(adminUserMatch[1], currentUser.id);
    revokeAdminSessions(user.id);
    return sendJson(response, 200, { user });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/me/password") {
    const currentUser = requireAdmin(request, response);
    if (!currentUser) return;
    const body = await readBody(request);
    getAdminUsers().changePassword(currentUser.id, body.currentPassword, body.newPassword);
    revokeAdminSessions(currentUser.id);
    return sendJson(response, 200, { ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/admin/answer-codes") {
    if (!requireAdminPermission(request, response, "answer_codes")) return;
    return sendJson(response, 200, {
      answerCodes: state.answerCodes.slice().reverse().map((answerCode) => answerCodeView(answerCode)),
    });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/answer-codes") {
    const currentUser = requireAdminPermission(request, response, "answer_codes");
    if (!currentUser) return;
    const body = await readBody(request);
    try {
      const answerCode = createAnswerCode(body, currentUser, state.answerCodes);
      state.answerCodes.push(answerCode);
      saveState();
      return sendJson(response, 201, { answerCode: answerCodeView(answerCode) });
    } catch (error) {
      if (error instanceof AnswerCodeError) return sendError(response, error.status, error.message);
      throw error;
    }
  }

  const answerCodeMatch = url.pathname.match(/^\/api\/admin\/answer-codes\/([^/]+)$/);
  if (request.method === "PATCH" && answerCodeMatch) {
    if (!requireAdminPermission(request, response, "answer_codes")) return;
    const answerCode = state.answerCodes.find((item) => item.id === answerCodeMatch[1]);
    if (!answerCode) return sendError(response, 404, "答题码不存在");
    const body = await readBody(request);
    if (body.active !== undefined) answerCode.status = body.active ? "active" : "disabled";
    if (body.note !== undefined) answerCode.note = cleanText(body.note, 120);
    answerCode.updatedAt = nowIso();
    saveState();
    return sendJson(response, 200, { answerCode: answerCodeView(answerCode) });
  }

  if (request.method === "GET" && url.pathname === "/api/admin/question-bank") {
    if (!requireAdminPermission(request, response, "questions")) return;
    return sendJson(response, 200, {
      questions: questionBank.questions,
      blueprint: config.blueprint,
      summary: questionBankSummary(questionBank.questions, config.blueprint),
      updatedAt: questionBank.updatedAt || questionBank.generatedAt || null,
    });
  }

  if (request.method === "POST" && url.pathname === "/api/admin/questions") {
    if (!requireAdminPermission(request, response, "questions")) return;
    const body = await readBody(request);
    try {
      const question = normalizeQuestion(body);
      questionBank.questions.push(question);
      ensureBlueprintCapacity(questionBank.questions, config.blueprint);
      saveQuestionBank();
      return sendJson(response, 201, { question });
    } catch (error) {
      return sendError(response, 400, error.message || "题目保存失败");
    }
  }

  const questionMatch = url.pathname.match(/^\/api\/admin\/questions\/([^/]+)$/);
  if (request.method === "PUT" && questionMatch) {
    if (!requireAdminPermission(request, response, "questions")) return;
    const questionId = decodeURIComponent(questionMatch[1]);
    const index = questionBank.questions.findIndex((item) => item.id === questionId);
    if (index < 0) return sendError(response, 404, "题目不存在");
    const body = await readBody(request);
    try {
      const question = normalizeQuestion(body, questionId);
      const nextQuestions = [...questionBank.questions];
      nextQuestions[index] = question;
      ensureBlueprintCapacity(nextQuestions, config.blueprint);
      questionBank.questions = nextQuestions;
      saveQuestionBank();
      return sendJson(response, 200, { question });
    } catch (error) {
      return sendError(response, 400, error.message || "题目保存失败");
    }
  }

  if (request.method === "DELETE" && questionMatch) {
    if (!requireAdminPermission(request, response, "questions")) return;
    const questionId = decodeURIComponent(questionMatch[1]);
    const question = questionBank.questions.find((item) => item.id === questionId);
    if (!question) return sendError(response, 404, "题目不存在");
    try {
      const nextQuestions = questionBank.questions.filter((item) => item.id !== questionId);
      ensureBlueprintCapacity(nextQuestions, config.blueprint);
      questionBank.questions = nextQuestions;
      saveQuestionBank();
      return sendJson(response, 200, { question });
    } catch (error) {
      return sendError(response, 400, error.message || "题目删除失败");
    }
  }

  if (request.method === "POST" && url.pathname === "/api/admin/question-bank/config") {
    if (!requireAdminPermission(request, response, "questions")) return;
    const body = await readBody(request);
    try {
      const blueprint = normalizeBlueprint(body.blueprint);
      ensureBlueprintCapacity(questionBank.questions, blueprint);
      config.blueprint = blueprint;
      saveConfig();
      return sendJson(response, 200, { blueprint, summary: questionBankSummary(questionBank.questions, blueprint) });
    } catch (error) {
      return sendError(response, 400, error.message || "组卷规则保存失败");
    }
  }

  const confirmMatch = url.pathname.match(/^\/api\/admin\/payments\/([^/]+)\/confirm$/);
  if (request.method === "POST" && confirmMatch) {
    if (!requireAdminPermission(request, response, "payments")) return;
    expirePendingPayments();
    const payment = state.payments.find((item) => item.id === confirmMatch[1]);
    if (!payment) return sendError(response, 404, "付款申请不存在");
    if (expirePendingPayment(payment)) saveState();
    if (payment.status === "canceled") return sendError(response, 409, "付款申请已取消，不能再确认");
    if (payment.status === "paid") return sendJson(response, 200, paymentResponse(payment));
    if (payment.nativePrepayRequestedAt || (payment.paymentChannel === "wechat_native" && wechatPay.status.ready)) return sendError(response, 409, "微信订单须由到账通知或查单确认，请勿人工确认");
    payment.status = "paid";
    payment.paymentChannel = "manual";
    payment.confirmedAt = nowIso();
    saveState();
    return sendJson(response, 200, paymentResponse(payment));
  }

  const reviewMatch = url.pathname.match(/^\/api\/admin\/results\/([^/]+)\/review$/);
  if (request.method === "POST" && reviewMatch) {
    if (!requireAdminPermission(request, response, "results")) return;
    const body = await readBody(request);
    const result = state.results.find((item) => item.id === reviewMatch[1]);
    if (!result) return sendError(response, 404, "成绩不存在");
    const score = Number(body.finalScore);
    if (!Number.isFinite(score) || score < 0 || score > 100) return sendError(response, 400, "复核成绩应为 0-100");
    result.finalScore = Math.round(score);
    result.passed = result.finalScore >= config.passScore;
    result.reviewNote = cleanText(body.reviewNote, 200);
    result.reviewedAt = nowIso();
    createOrUpdateCertificate(result);
    saveState();
    return sendJson(response, 200, resultResponse(result));
  }

  const adminResultMatch = url.pathname.match(/^\/api\/admin\/results\/([^/]+)$/);
  if (request.method === "GET" && adminResultMatch) {
    if (!requireAdminPermission(request, response, "results")) return;
    const result = state.results.find((item) => item.id === adminResultMatch[1]);
    if (!result) return sendError(response, 404, "成绩不存在");
    return sendJson(response, 200, resultResponse(result, "admin"));
  }

  if (request.method === "POST" && url.pathname === "/api/admin/config") {
    if (!requireAdminPermission(request, response, "settings")) return;
    const body = await readBody(request);
    config.clubName = cleanText(body.clubName || config.clubName, 40);
    config.examTitle = cleanText(body.examTitle || config.examTitle, 50);
    config.paymentInstructions = cleanText(body.paymentInstructions || config.paymentInstructions, 240);
    config.contactText = cleanText(body.contactText || config.contactText, 160);
    if (body.examMinutes !== undefined) {
      const examMinutes = Number(body.examMinutes);
      if (!Number.isInteger(examMinutes) || examMinutes < MIN_EXAM_MINUTES || examMinutes > MAX_EXAM_MINUTES) {
        return sendError(response, 400, `答题时长应为 ${MIN_EXAM_MINUTES}-${MAX_EXAM_MINUTES} 分钟的整数`);
      }
      config.examMinutes = examMinutes;
    }

    if (body.qrDataUrl) {
      const match = String(body.qrDataUrl).match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
      if (!match) return sendError(response, 400, "收款码仅支持 PNG、JPG、WebP");
      const image = Buffer.from(match[2], "base64");
      if (image.length > 2_000_000) return sendError(response, 400, "收款码图片不能超过 2MB");
      const extension = match[1] === "jpeg" ? "jpg" : match[1];
      for (const oldFile of fs.readdirSync(DATA_DIR).filter((name) => name.startsWith("payment-qr."))) {
        fs.rmSync(path.join(DATA_DIR, oldFile), { force: true });
      }
      const qrFile = path.join(DATA_DIR, `payment-qr.${extension}`);
      fs.writeFileSync(qrFile, image);
      config.qrFile = qrFile;
    }
    saveConfig();
    return sendJson(response, 200, publicConfig());
  }

  return sendError(response, 404, "接口不存在");
}

function serveStatic(request, response, url) {
  const routeMap = {
    "/": "index.html",
    "/admin": "admin.html",
    "/certificate": "certificate.html",
  };
  const requested = routeMap[url.pathname] || url.pathname.replace(/^\/+/, "");
  const filePath = path.resolve(PUBLIC_DIR, requested || "index.html");
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) && filePath !== PUBLIC_DIR) {
    response.writeHead(403);
    return response.end("Forbidden");
  }
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return response.end("页面不存在");
  }
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".ico": "image/x-icon",
  };
  const extension = path.extname(filePath);
  const shouldRevalidate = [".html", ".css", ".js", ".mjs"].includes(extension);
  response.writeHead(200, {
    "Content-Type": types[extension] || "application/octet-stream",
    "Cache-Control": shouldRevalidate ? "no-cache, no-store, must-revalidate" : "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
  });
  return fs.createReadStream(filePath).pipe(response);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) return await handleApi(request, response, url);
    return serveStatic(request, response, url);
  } catch (error) {
    console.error(error);
    if (!response.headersSent) sendError(response, error instanceof AdminUserError ? error.status : 500, error.message || "服务器内部错误");
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, HOST, () => {
    expirePendingPayments();
    setInterval(() => expirePendingPayments(), 60_000).unref();
    console.log(`${config.clubName}${config.examTitle}已启动：http://localhost:${PORT}`);
    if (!wechatPay.status.ready) console.log("微信收款待配置：" + wechatPay.status.missing.join("、"));
    if (ADMIN_PASSWORD === "admin123") console.log("管理员初始密码：admin123（部署前请设置 ADMIN_PASSWORD）");
  });
}

export { server, feeForAttempt, attemptsFor, resultResponse };
