import test from "node:test";
import assert from "node:assert/strict";
import { createExamQuestions, gradeExam, sanitizeResultDetails, scoreSubjectiveHeuristic, validateQuestionBank, EXAM_BLUEPRINT } from "../src/exam-engine.js";

const bank = {
  questions: Object.entries(EXAM_BLUEPRINT).flatMap(([type, count]) => Array.from({ length: count }, (_, index) => {
    const id = `${type}-${String(index + 1).padStart(2, "0")}`;
    if (type === "single") return { id, type, prompt: `示例单选题 ${index + 1}`, options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }], answer: ["A"], points: 2 };
    if (type === "multiple") return { id, type, prompt: `示例多选题 ${index + 1}`, options: [{ key: "A", text: "甲" }, { key: "B", text: "乙" }], answer: ["A", "B"], points: 3 };
    if (type === "fill") return { id, type, prompt: `示例填空题 ${index + 1}`, acceptedAnswers: ["答案"], answer: "答案", points: 2 };
    if (type === "judge") return { id, type, prompt: `示例判断题 ${index + 1}`, answer: "true", points: 2 };
    return { id, type, prompt: `示例主观题 ${index + 1}`, referenceAnswer: "这是一个足够长的标准参考答案。", points: type === "short" ? 5 : 9 };
  })),
};

test("题库满足组卷数量", () => {
  assert.equal(validateQuestionBank(bank), true);
  const exam = createExamQuestions(bank);
  assert.equal(exam.length, 30);
  assert.equal(new Set(exam.map((question) => question.id)).size, 30);
  for (const [type, count] of Object.entries(EXAM_BLUEPRINT)) {
    assert.equal(exam.filter((question) => question.type === type).length, count);
  }
});

test("连续组卷会优先抽取该考生尚未做过的题目", () => {
  const expandedBank = {
    questions: Object.entries(EXAM_BLUEPRINT).flatMap(([type, count]) => Array.from({ length: count * 2 }, (_, index) => ({
      id: `${type}-expanded-${index + 1}`,
      type,
      prompt: `${type} 扩展题 ${index + 1}`,
      points: 1,
    }))),
  };
  const first = createExamQuestions(expandedBank);
  const second = createExamQuestions(expandedBank, EXAM_BLUEPRINT, { previousQuestionIds: first.map((question) => question.id) });
  const firstIds = new Set(first.map((question) => question.id));
  assert.equal(second.some((question) => firstIds.has(question.id)), false);
});

test("全对答案得到 100 分", () => {
  const exam = createExamQuestions(bank);
  const answers = Object.fromEntries(exam.map((question) => {
    if (question.type === "fill") return [question.id, question.acceptedAnswers[0]];
    if (question.type === "short" || question.type === "scenario") return [question.id, question.referenceAnswer];
    return [question.id, question.answer];
  }));
  const result = gradeExam(exam, answers);
  assert.equal(result.score, 100);
});

test("空白答卷得到 0 分", () => {
  const result = gradeExam(createExamQuestions(bank), {});
  assert.equal(result.score, 0);
});

test("考生成绩明细不会泄露答案或作答内容", () => {
  const sanitized = sanitizeResultDetails([{
    id: "single-01",
    order: 7,
    type: "single",
    prompt: "示例题目",
    submitted: "A",
    earned: 0,
    maximum: 2,
    correct: false,
    correctAnswer: ["B"],
  }]);

  assert.deepEqual(sanitized, [{ id: "single-01", order: 7, type: "single", earned: 0, maximum: 2, correct: false }]);
  assert.equal("correctAnswer" in sanitized[0], false);
  assert.equal("submitted" in sanitized[0], false);
  assert.equal("prompt" in sanitized[0], false);
});

test("主观题改写答案能够按评分要点获得合理部分分", () => {
  const question = {
    id: "short-meaning",
    order: 1,
    type: "short",
    prompt: "误入老板房间后怎么办？",
    referenceAnswer: "必须立刻主动向老板道歉，在取得老板谅解之后方可退出房间；严禁不打招呼直接悄悄离开，严禁在房间内逗留、打扰老板接单。",
    points: 5,
  };
  const result = gradeExam([question], { "short-meaning": "先向老板道歉，征得谅解后再退出，不能直接离开或继续打扰接单。" });
  assert.ok(result.earnedRaw >= 2.5, `expected meaningful partial credit, received ${result.earnedRaw}`);
});

test("主观评分器可以替换，为后续 AI 评分预留接口", () => {
  const question = { id: "scenario-ai", order: 1, type: "scenario", prompt: "情景题", referenceAnswer: "参考答案内容完整。", points: 9 };
  const result = gradeExam([question], { "scenario-ai": "考生答案" }, { subjectiveGrader: () => 7.5 });
  assert.equal(result.earnedRaw, 7.5);
});

test("简短标准答案完全匹配时可以得到满分", () => {
  assert.equal(scoreSubjectiveHeuristic("全卡", "正确答案：全卡", 5), 5);
});
