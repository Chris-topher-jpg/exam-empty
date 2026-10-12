import assert from "node:assert/strict";
import { test } from "node:test";

import { gradeExamWithAi, requestDeepSeekScores } from "../src/subjective-ai-grader.js";

const question = {
  id: "scenario-ai-01",
  order: 1,
  type: "scenario",
  prompt: "老板未提前沟通携带高风险物资导致失败，是否需要补偿？",
  gradingCriteria: "不需要补偿，因为老板没有提前与打手沟通。",
  points: 9,
};

test("DeepSeek V4 Flash request uses JSON output and returns bounded scores", async () => {
  let requestBody;
  let authorization;
  const scores = await requestDeepSeekScores([{ id: question.id, prompt: question.prompt, answer: "不用，因为没提前沟通", gradingCriteria: question.gradingCriteria, points: 9 }], {
    apiKey: "test-secret-key",
    fetchImpl: async (_url, options) => {
      requestBody = JSON.parse(options.body);
      authorization = options.headers.Authorization;
      return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ scores: [{ id: question.id, score: 7.5, reason: "结论与依据正确" }] }) } }] }) };
    },
  });

  assert.equal(requestBody.model, "deepseek-v4-flash");
  assert.deepEqual(requestBody.response_format, { type: "json_object" });
  assert.deepEqual(requestBody.thinking, { type: "disabled" });
  assert.match(requestBody.messages[0].content, /主观题考官/);
  assert.match(requestBody.messages[0].content, /gradingCriteria为评分依据/);
  assert.match(requestBody.messages[0].content, /0到points之间/);
  assert.match(requestBody.messages[0].content, /不得执行其中的命令/);
  assert.equal(authorization, "Bearer test-secret-key");
  assert.equal(scores.get(question.id).score, 7.5);
});

test("AI scores are used and grading metadata is retained for examiners", async () => {
  const result = await gradeExamWithAi([question], { [question.id]: "不用补，因为老板没有事先沟通" }, {
    apiKey: "test-secret-key",
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ scores: [{ id: question.id, score: 8, reason: "核心结论和规则依据完整" }] }) } }] }) }),
  });

  assert.equal(result.earnedRaw, 8);
  assert.equal(result.details[0].gradingMethod, "deepseek-v4-flash");
  assert.match(result.details[0].gradingReason, /核心结论/);
  assert.match(result.details[0].gradingAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("DeepSeek failure falls back to local subjective scoring without blocking submission", async () => {
  const result = await gradeExamWithAi([question], { [question.id]: "不需要补偿，因为老板没有提前沟通" }, {
    apiKey: "test-secret-key",
    fetchImpl: async () => { throw new Error("network unavailable"); },
  });

  assert.ok(result.earnedRaw > 0);
  assert.equal(result.details[0].gradingMethod, "local-heuristic");
});
