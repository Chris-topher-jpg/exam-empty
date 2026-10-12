import assert from "node:assert/strict";
import { test } from "node:test";

import { ensureBlueprintCapacity, normalizeBlueprint, normalizeQuestion } from "../src/question-bank.js";

test("choice question validates options and answers", () => {
  const question = normalizeQuestion({ type: "multiple", prompt: "哪些选项正确？", points: 4, options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }], answer: ["A", "B"], category: "规则" });
  assert.deepEqual(question.answer, ["A", "B"]);
  assert.equal(question.enabled, true);
  assert.throws(() => normalizeQuestion({ type: "single", prompt: "错误示例", points: 2, options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }], answer: ["A", "B"] }), /只能设置一个/);
});

test("fill and subjective questions require grading answers", () => {
  assert.deepEqual(normalizeQuestion({ type: "fill", prompt: "请填空", points: 2, acceptedAnswers: ["答案一", "答案二"] }).acceptedAnswers, ["答案一", "答案二"]);
  assert.throws(() => normalizeQuestion({ type: "short", prompt: "请简答", points: 5, gradingCriteria: "短" }), /打分标准至少需要 4 个字符/);
});

test("blueprint cannot exceed enabled question capacity", () => {
  const blueprint = normalizeBlueprint({ single: 1, multiple: 0, fill: 0, judge: 0, short: 0, scenario: 0 });
  assert.equal(ensureBlueprintCapacity([{ type: "single", enabled: true }], blueprint), true);
  assert.throws(() => ensureBlueprintCapacity([{ type: "single", enabled: false }], blueprint), /启用题目不足/);
});
