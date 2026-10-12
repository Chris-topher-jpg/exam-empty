import crypto from "node:crypto";

import { EXAM_BLUEPRINT, QUESTION_TYPE_LABELS } from "./exam-engine.js";

const TYPES = new Set(Object.keys(QUESTION_TYPE_LABELS));

function clean(value, maxLength = 1000) {
  return String(value || "").trim().slice(0, maxLength);
}

function cleanList(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(/[\n,，]/);
  return [...new Set(source.map((item) => clean(item, 300)).filter(Boolean))];
}

function normalizeOptions(value) {
  if (!Array.isArray(value)) return [];
  return value.map((option, index) => ({
    key: clean(option?.key || String.fromCharCode(65 + index), 8).toUpperCase(),
    text: clean(option?.text, 300),
  })).filter((option) => option.key && option.text);
}

export function normalizeQuestion(input, existingId = "") {
  const type = clean(input.type, 20);
  if (!TYPES.has(type)) throw new Error("题型无效");
  const prompt = clean(input.prompt, 2000);
  if (prompt.length < 2) throw new Error("题目内容至少需要 2 个字符");
  const points = Number(input.points);
  if (!Number.isFinite(points) || points <= 0 || points > 100) throw new Error("分值应为 0-100 之间的正数");

  const question = {
    id: existingId || `q-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`,
    type,
    prompt,
    points: Number(points.toFixed(2)),
    category: clean(input.category, 80),
    explanation: clean(input.explanation, 2000),
    enabled: input.enabled !== false,
  };

  if (type === "single" || type === "multiple") {
    question.options = normalizeOptions(input.options);
    if (question.options.length < 2) throw new Error("选择题至少需要 2 个有效选项");
    const keys = question.options.map((option) => option.key);
    if (new Set(keys).size !== keys.length) throw new Error("选项标识不能重复");
    question.answer = cleanList(input.answer).map((item) => item.toUpperCase());
    if (!question.answer.length || question.answer.some((answer) => !keys.includes(answer))) throw new Error("请选择有效的正确答案");
    if (type === "single" && question.answer.length !== 1) throw new Error("单选题只能设置一个正确答案");
  } else if (type === "judge") {
    const answer = String(input.answer);
    if (!new Set(["true", "false"]).has(answer)) throw new Error("判断题答案必须为正确或错误");
    question.answer = answer;
  } else if (type === "fill") {
    question.acceptedAnswers = cleanList(input.acceptedAnswers?.length ? input.acceptedAnswers : input.answer);
    if (!question.acceptedAnswers.length) throw new Error("填空题至少需要一个可接受答案");
    question.answer = question.acceptedAnswers[0];
  } else {
    question.gradingCriteria = clean(input.gradingCriteria || input.referenceAnswer || input.answer, 4000);
    if (question.gradingCriteria.length < 4) throw new Error("主观题打分标准至少需要 4 个字符");
  }

  return question;
}

export function normalizeBlueprint(input) {
  const blueprint = {};
  for (const type of Object.keys(EXAM_BLUEPRINT)) {
    const count = Number(input?.[type]);
    if (!Number.isInteger(count) || count < 0 || count > 100) throw new Error(`${QUESTION_TYPE_LABELS[type]}抽题数量应为 0-100 的整数`);
    blueprint[type] = count;
  }
  if (!Object.values(blueprint).some(Boolean)) throw new Error("组卷题目总数不能为 0");
  return blueprint;
}

export function ensureBlueprintCapacity(questions, blueprint) {
  for (const [type, required] of Object.entries(blueprint)) {
    const available = questions.filter((question) => question.type === type && question.enabled !== false).length;
    if (available < required) throw new Error(`${QUESTION_TYPE_LABELS[type]}启用题目不足：组卷需要 ${required} 题，当前 ${available} 题`);
  }
  return true;
}

export function questionBankSummary(questions, blueprint) {
  return Object.keys(EXAM_BLUEPRINT).map((type) => ({
    type,
    label: QUESTION_TYPE_LABELS[type],
    total: questions.filter((question) => question.type === type).length,
    enabled: questions.filter((question) => question.type === type && question.enabled !== false).length,
    drawCount: blueprint[type] || 0,
  }));
}
