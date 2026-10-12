import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

let server;
let baseUrl;
let directory;
let adminToken;

function fixtureQuestions() {
  const blueprint = { single: 20, multiple: 2, fill: 0, judge: 8, short: 0, scenario: 0 };
  return Object.entries(blueprint).flatMap(([type, count]) => Array.from({ length: count * 2 }, (_, index) => ({
    id: `${type}-${index + 1}`,
    type,
    prompt: `fixture ${type} ${index + 1}`,
    points: 2,
    ...(type === "single" || type === "multiple" ? { options: [{ key: "A", text: "A" }, { key: "B", text: "B" }], answer: ["A"] } : {}),
    ...(type === "fill" ? { answer: "答案", acceptedAnswers: ["答案"] } : {}),
    ...(type === "judge" ? { answer: "true" } : {}),
    ...(type === "short" || type === "scenario" ? { gradingCriteria: "这是一个足够长的打分标准。" } : {}),
  })));
}

async function request(url, options = {}) {
  const { token, ...requestOptions } = options;
  const response = await fetch(`${baseUrl}${url}`, { ...requestOptions, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const data = await response.json();
  return { response, data };
}

before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "jqdj-answer-code-api-"));
  process.env.ADMIN_PASSWORD = "Answer_Code_Owner_2026";
  process.env.DEMO_AUTO_PAY = "0";
  process.env.ONBOARDING_EXAM_STATE_PATH = path.join(directory, "state.json");
  process.env.ONBOARDING_EXAM_CONFIG_PATH = path.join(directory, "config.json");
  process.env.ONBOARDING_EXAM_ADMIN_USERS_PATH = path.join(directory, "admin-users.json");
  process.env.ONBOARDING_EXAM_QUESTION_BANK_PATH = path.join(directory, "question-bank.json");
  fs.writeFileSync(process.env.ONBOARDING_EXAM_QUESTION_BANK_PATH, JSON.stringify({ questions: fixtureQuestions() }));
  const legacyPayment = {
    amount: 5, attemptNumber: 1, candidateName: "旧规则考生", createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(), usedAt: null, examId: null,
  };
  fs.writeFileSync(process.env.ONBOARDING_EXAM_STATE_PATH, JSON.stringify({
    payments: [
      { ...legacyPayment, id: "legacy-pending", token: "legacy-pending-token", candidateKey: "legacy-pending", candidateId: "legacy-pending", status: "pending" },
      { ...legacyPayment, id: "legacy-paid", token: "legacy-paid-token", candidateKey: "legacy-paid", candidateId: "legacy-paid", status: "paid" },
    ],
    exams: [], results: [], certificates: [], answerCodes: [],
  }));
  ({ server } = await import("../server.js"));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = await request("/api/admin/login", { method: "POST", body: JSON.stringify({ username: "admin", password: "Answer_Code_Owner_2026" }) });
  adminToken = login.data.token;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  fs.rmSync(directory, { recursive: true, force: true });
});

test("admin-generated answer code bypasses payment and can optionally count as revenue", async () => {
  const beforeDashboard = await request("/api/admin/dashboard", { token: adminToken });
  const created = await request("/api/admin/answer-codes", { method: "POST", token: adminToken, body: JSON.stringify({ note: "测试码", usageLimit: 2, validHours: 24, countAsRevenue: true }) });
  assert.equal(created.response.status, 201);
  assert.equal(created.data.answerCode.countAsRevenue, true);

  const redeemed = await request("/api/answer-codes/redeem", { method: "POST", body: JSON.stringify({ candidateName: "测试考生", candidateId: "DONGDONG-1001", code: created.data.answerCode.code }) });
  assert.equal(redeemed.response.status, 201);
  assert.equal(redeemed.data.status, "paid");
  assert.equal(redeemed.data.amount, 0);
  assert.equal(redeemed.data.paymentChannel, "answer_code");

  const exam = await request("/api/exams/start", { method: "POST", body: JSON.stringify({ paymentToken: redeemed.data.token }) });
  assert.equal(exam.response.status, 201);
  assert.ok(exam.data.id);
  const remainingMinutes = (new Date(exam.data.expiresAt).getTime() - Date.now()) / 60_000;
  assert.ok(remainingMinutes > 17.8 && remainingMinutes <= 18);

  const codes = await request("/api/admin/answer-codes", { token: adminToken });
  assert.equal(codes.data.answerCodes[0].usedCount, 1);
  assert.equal(codes.data.answerCodes[0].redemptions[0].candidateId, "DONGDONG-1001");
  assert.ok(codes.data.answerCodes[0].redemptions[0].paymentId);

  const freeDashboard = await request("/api/admin/dashboard", { token: adminToken });
  assert.equal(freeDashboard.data.stats.totalRevenue, beforeDashboard.data.stats.totalRevenue);
  assert.equal(freeDashboard.data.stats.paidPayments, beforeDashboard.data.stats.paidPayments);

  const secondPayment = await request("/api/answer-codes/redeem", { method: "POST", body: JSON.stringify({ candidateName: "测试考生", candidateId: "DONGDONG-1001", code: created.data.answerCode.code }) });
  assert.equal(secondPayment.data.amount, 20);
  assert.equal(secondPayment.data.status, "paid");
  const dashboard = await request("/api/admin/dashboard", { token: adminToken });
  assert.equal(dashboard.data.stats.totalRevenue - beforeDashboard.data.stats.totalRevenue, 20);
  assert.equal(dashboard.data.stats.paidPayments - beforeDashboard.data.stats.paidPayments, 1);
});

test("personal fees are free, 20, then 30 through six attempts with no payment required for the first", async () => {
  const candidate = { candidateName: "收费测试考生", candidateId: "FEE-SCHEDULE-1001" };
  const fees = [0, 20, 30, 30, 30, 30];
  const publicConfig = await request("/api/config");
  assert.deepEqual(publicConfig.data.feeSchedule, fees);
  assert.match(publicConfig.data.feePolicy, /考费全部归考官/);
  const initialDashboard = await request("/api/admin/dashboard", { token: adminToken });

  for (const [index, amount] of fees.entries()) {
    const status = await request("/api/candidate/status", { method: "POST", body: JSON.stringify(candidate) });
    assert.equal(status.data.nextFee, amount);
    assert.equal(status.data.attemptsRemaining, 6 - index);
    const payment = await request("/api/payment/request", { method: "POST", body: JSON.stringify({ ...candidate, amount: 0 }) });
    assert.equal(payment.response.status, 201);
    assert.equal(payment.data.amount, amount);
    assert.equal(payment.data.attemptNumber, index + 1);
    assert.equal(payment.data.status, amount === 0 ? "paid" : "pending");
    const repeated = await request("/api/payment/request", { method: "POST", body: JSON.stringify(candidate) });
    assert.equal(repeated.data.id, payment.data.id);

    if (amount === 0) {
      assert.equal(payment.data.paymentChannel, "free");
      assert.ok(payment.data.confirmedAt);
      const native = await request("/api/payment/native-prepay", { method: "POST", body: JSON.stringify({ token: payment.data.token }) });
      assert.equal(native.response.status, 200);
      assert.equal(native.data.codeUrl, null);
      const freeDashboard = await request("/api/admin/dashboard", { token: adminToken });
      assert.equal(freeDashboard.data.stats.paidPayments, initialDashboard.data.stats.paidPayments);
    } else {
      const blocked = await request("/api/exams/start", { method: "POST", body: JSON.stringify({ paymentToken: payment.data.token }) });
      assert.equal(blocked.response.status, 403);
      const confirmed = await request(`/api/admin/payments/${payment.data.id}/confirm`, { method: "POST", token: adminToken });
      assert.equal(confirmed.response.status, 200);
    }
    const exam = await request("/api/exams/start", { method: "POST", body: JSON.stringify({ paymentToken: payment.data.token }) });
    assert.equal(exam.response.status, 201);
    const repeatedExam = await request("/api/exams/start", { method: "POST", body: JSON.stringify({ paymentToken: payment.data.token }) });
    assert.equal(repeatedExam.data.id, exam.data.id);
  }

  const finalStatus = await request("/api/candidate/status", { method: "POST", body: JSON.stringify(candidate) });
  assert.equal(finalStatus.data.attemptsRemaining, 0);
  assert.equal(finalStatus.data.nextFee, null);
  const seventh = await request("/api/payment/request", { method: "POST", body: JSON.stringify(candidate) });
  assert.equal(seventh.response.status, 403);
  const dashboard = await request("/api/admin/dashboard", { token: adminToken });
  assert.equal(dashboard.data.stats.totalRevenue - initialDashboard.data.stats.totalRevenue, 140);
  assert.equal(dashboard.data.stats.paidPayments - initialDashboard.data.stats.paidPayments, 5);
  assert.equal(dashboard.data.analytics.paymentChannels.reduce((sum, item) => sum + item.count, 0), dashboard.data.stats.paidPayments);
});

test("old pending fees are canceled while confirmed historical payments retain their amount", async () => {
  const oldStatus = await request("/api/payment/status/legacy-pending-token");
  assert.equal(oldStatus.data.status, "canceled");
  assert.equal(oldStatus.data.cancelReason, "fee_policy_changed");
  const confirm = await request("/api/admin/payments/legacy-pending/confirm", { method: "POST", token: adminToken });
  assert.equal(confirm.response.status, 409);
  const replacement = await request("/api/payment/request", { method: "POST", body: JSON.stringify({ candidateName: "旧规则考生", candidateId: "legacy-pending" }) });
  assert.equal(replacement.data.amount, 0);
  assert.equal(replacement.data.status, "paid");
  const paid = await request("/api/payment/request", { method: "POST", body: JSON.stringify({ candidateName: "旧规则考生", candidateId: "legacy-paid" }) });
  assert.equal(paid.data.id, "legacy-paid");
  assert.equal(paid.data.amount, 5);
  assert.equal(paid.data.status, "paid");
});

test("the same candidate can consume a multi-use answer code for separate exams", async () => {
  const created = await request("/api/admin/answer-codes", {
    method: "POST",
    token: adminToken,
    body: JSON.stringify({ note: "复考码", usageLimit: 2, validHours: 24 }),
  });
  const candidate = { candidateName: "复考考生", candidateId: "DONGDONG-REPEAT", code: created.data.answerCode.code };

  const firstPayment = await request("/api/answer-codes/redeem", { method: "POST", body: JSON.stringify(candidate) });
  const firstExam = await request("/api/exams/start", { method: "POST", body: JSON.stringify({ paymentToken: firstPayment.data.token }) });
  const firstPaper = await request(`/api/exams/${firstExam.data.id}?token=${firstExam.data.accessToken}`);

  const secondPayment = await request("/api/answer-codes/redeem", { method: "POST", body: JSON.stringify(candidate) });
  const secondExam = await request("/api/exams/start", { method: "POST", body: JSON.stringify({ paymentToken: secondPayment.data.token }) });
  const secondPaper = await request(`/api/exams/${secondExam.data.id}?token=${secondExam.data.accessToken}`);

  assert.equal(firstPayment.response.status, 201);
  assert.equal(secondPayment.response.status, 201);
  assert.notEqual(secondPayment.data.id, firstPayment.data.id);
  assert.equal(secondExam.data.status, "active");
  assert.notEqual(secondExam.data.id, firstExam.data.id);
  assert.equal(secondPaper.data.attemptNumber, 2);
  const firstQuestionIds = new Set(firstPaper.data.questions.map((question) => question.id));
  assert.equal(secondPaper.data.questions.some((question) => firstQuestionIds.has(question.id)), false);

  const codes = await request("/api/admin/answer-codes", { token: adminToken });
  const answerCode = codes.data.answerCodes.find((item) => item.id === created.data.answerCode.id);
  assert.equal(answerCode.usedCount, 2);
});

test("administrator can configure the time limit for new exams", async () => {
  const updated = await request("/api/admin/config", {
    method: "POST",
    token: adminToken,
    body: JSON.stringify({ examMinutes: 15 }),
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.data.examMinutes, 15);

  const publicConfig = await request("/api/config");
  assert.equal(publicConfig.data.examMinutes, 15);

  const invalid = await request("/api/admin/config", {
    method: "POST",
    token: adminToken,
    body: JSON.stringify({ examMinutes: 0 }),
  });
  assert.equal(invalid.response.status, 400);
});
