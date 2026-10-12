import assert from "node:assert/strict";
import { test } from "node:test";

import { answerCodeView, createAnswerCode, generateAnswerCode, redeemAnswerCode } from "../src/answer-codes.js";

const actor = { id: "owner-1", username: "admin", displayName: "所有者" };

test("answer codes are high-entropy formatted and auditable", () => {
  const answerCode = createAnswerCode({ usageLimit: 2, validHours: 48, note: "线下活动" }, actor, [], new Date("2026-08-26T00:00:00.000Z"));
  assert.match(answerCode.code, /^JQ-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(answerCode.usageLimit, 2);
  assert.equal(answerCode.createdBy.username, "admin");
  assert.equal(answerCode.note, "线下活动");
  assert.equal(answerCode.countAsRevenue, false);
  const revenueCode = createAnswerCode({ usageLimit: 1, validHours: 24, countAsRevenue: true }, actor, [answerCode]);
  assert.equal(revenueCode.countAsRevenue, true);
});

test("answer code redemption tracks candidate and enforces usage limits", () => {
  const code = createAnswerCode({ usageLimit: 2, validHours: 24 }, actor, [], new Date("2026-08-26T00:00:00.000Z"));
  const first = redeemAnswerCode([code], { code: code.code, candidateKey: "dongdong-1", candidateName: "小明", candidateId: "10001" }, new Date("2026-08-26T01:00:00.000Z"));
  assert.equal(first.reused, false);
  assert.equal(first.redemption.candidateId, "10001");
  const repeated = redeemAnswerCode([code], { code: code.code, candidateKey: "dongdong-1", candidateName: "小明", candidateId: "10001" }, new Date("2026-08-26T01:01:00.000Z"));
  assert.equal(repeated.reused, false);
  assert.notEqual(repeated.redemption.id, first.redemption.id);
  assert.throws(() => redeemAnswerCode([code], { code: code.code, candidateKey: "dongdong-2", candidateName: "小红", candidateId: "10002" }, new Date("2026-08-26T01:02:00.000Z")), /使用次数已用完/);
  assert.equal(answerCodeView(code).usedCount, 2);
});

test("expired and disabled answer codes cannot be redeemed", () => {
  const expired = createAnswerCode({ validHours: 1 }, actor, [], new Date("2026-08-26T00:00:00.000Z"));
  assert.throws(() => redeemAnswerCode([expired], { code: expired.code, candidateKey: "x" }, new Date("2026-08-26T02:00:00.000Z")), /已过期/);
  const disabled = createAnswerCode({ validHours: 24 }, actor, [expired]);
  disabled.status = "disabled";
  assert.throws(() => redeemAnswerCode([disabled], { code: disabled.code, candidateKey: "x" }), /已停用/);
});

test("generator avoids existing codes", () => {
  const bytes = Buffer.from([0, 0, 0, 0]);
  let call = 0;
  const randomBytes = () => Buffer.from(bytes.map((value) => value + call++));
  const first = generateAnswerCode([], randomBytes);
  const second = generateAnswerCode([{ code: first }], randomBytes);
  assert.notEqual(second, first);
});
