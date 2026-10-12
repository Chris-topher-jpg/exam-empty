import crypto from "node:crypto";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export class AnswerCodeError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "AnswerCodeError";
    this.status = status;
  }
}

export function normalizeAnswerCode(value) {
  return String(value || "").trim().toUpperCase().replace(/[\s_]+/g, "-");
}

function randomSegment(randomBytes = crypto.randomBytes) {
  const bytes = randomBytes(4);
  return [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

export function generateAnswerCode(existingCodes = [], randomBytes = crypto.randomBytes) {
  const existing = new Set(existingCodes.map((item) => normalizeAnswerCode(item.code)));
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const code = `JQ-${randomSegment(randomBytes)}-${randomSegment(randomBytes)}-${randomSegment(randomBytes)}`;
    if (!existing.has(code)) return code;
  }
  throw new AnswerCodeError("无法生成唯一答题码，请重试", 500);
}

export function createAnswerCode(input, actor, existingCodes = [], now = new Date()) {
  const usageLimit = Number(input.usageLimit || 1);
  const validHours = Number(input.validHours || 24);
  if (!Number.isInteger(usageLimit) || usageLimit < 1 || usageLimit > 1000) throw new AnswerCodeError("可用次数应为 1-1000 的整数");
  if (!Number.isFinite(validHours) || validHours < 1 || validHours > 24 * 365) throw new AnswerCodeError("有效时间应为 1-8760 小时");
  return {
    id: `ac_${crypto.randomBytes(12).toString("base64url")}`,
    code: generateAnswerCode(existingCodes),
    note: String(input.note || "").trim().slice(0, 120),
    status: "active",
    usageLimit,
    countAsRevenue: input.countAsRevenue === true,
    expiresAt: new Date(now.getTime() + validHours * 60 * 60_000).toISOString(),
    createdAt: now.toISOString(),
    createdBy: { id: actor.id, username: actor.username, displayName: actor.displayName },
    redemptions: [],
  };
}

export function answerCodeView(answerCode, now = new Date()) {
  const usedCount = answerCode.redemptions?.length || 0;
  const expired = new Date(answerCode.expiresAt).getTime() <= now.getTime();
  const exhausted = usedCount >= answerCode.usageLimit;
  return {
    ...answerCode,
    usedCount,
    availableCount: Math.max(0, answerCode.usageLimit - usedCount),
    effectiveStatus: answerCode.status !== "active" ? "disabled" : expired ? "expired" : exhausted ? "exhausted" : "active",
  };
}

export function redeemAnswerCode(answerCodes, input, now = new Date()) {
  const code = normalizeAnswerCode(input.code);
  const answerCode = answerCodes.find((item) => normalizeAnswerCode(item.code) === code);
  if (!answerCode) throw new AnswerCodeError("答题码无效", 404);
  const view = answerCodeView(answerCode, now);
  if (view.effectiveStatus === "disabled") throw new AnswerCodeError("答题码已停用", 410);
  if (view.effectiveStatus === "expired") throw new AnswerCodeError("答题码已过期", 410);
  if (view.effectiveStatus === "exhausted") throw new AnswerCodeError("答题码使用次数已用完", 410);
  const redemption = {
    id: `acr_${crypto.randomBytes(10).toString("base64url")}`,
    candidateKey: input.candidateKey,
    candidateName: String(input.candidateName || "").slice(0, 30),
    candidateId: String(input.candidateId || "").slice(0, 50),
    redeemedAt: now.toISOString(),
    paymentId: null,
  };
  answerCode.redemptions = [...(answerCode.redemptions || []), redemption];
  return { answerCode, redemption, reused: false };
}
