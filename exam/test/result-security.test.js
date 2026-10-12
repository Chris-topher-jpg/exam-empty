import assert from "node:assert/strict";
import { test } from "node:test";

import { resultResponse } from "../src/result-response.js";

const result = {
  id: "result-security",
  candidateName: "测试考生",
  candidateId: "TEST-SECURITY",
  attemptNumber: 1,
  automaticScore: 50,
  finalScore: 50,
  passed: false,
  submittedAt: "2026-08-26T00:00:00.000Z",
  certificateId: null,
  reviewNote: "",
  details: [{
    id: "single-01",
    order: 12,
    type: "single",
    prompt: "题目内容",
    submitted: "A",
    earned: 0,
    maximum: 2,
    correct: false,
    correctAnswer: ["B"],
  }],
};

test("candidate result responses omit answers and submitted content", () => {
  const response = resultResponse(result, "candidate", 85);

  assert.deepEqual(response.details, [{ id: "single-01", order: 12, type: "single", earned: 0, maximum: 2, correct: false }]);
  assert.equal("correctAnswer" in response.details[0], false);
  assert.equal("submitted" in response.details[0], false);
  assert.equal("prompt" in response.details[0], false);
});

test("admin result responses retain details for authorized examiners", () => {
  const response = resultResponse(result, "admin", 85);

  assert.equal(response.details[0].correctAnswer[0], "B");
  assert.equal(response.details[0].submitted, "A");
});
