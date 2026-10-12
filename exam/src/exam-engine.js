import crypto from "node:crypto";

export const EXAM_BLUEPRINT = Object.freeze({
  single: 20,
  multiple: 2,
  fill: 0,
  judge: 8,
  short: 0,
  scenario: 0,
});

export const QUESTION_TYPE_LABELS = Object.freeze({
  single: "单项选择题",
  multiple: "多项选择题",
  fill: "填空题",
  judge: "判断题",
  short: "简答题",
  scenario: "情景题",
});

export function normalizeText(value = "") {
  return String(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "");
}

function shuffle(values) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function comparableBigrams(value) {
  const normalized = normalizeText(value);
  const grams = new Set();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    grams.add(normalized.slice(index, index + 2));
  }
  return grams;
}

function diceSimilarity(left, right) {
  const leftGrams = comparableBigrams(left);
  const rightGrams = comparableBigrams(right);
  if (!leftGrams.size || !rightGrams.size) return 0;
  let intersection = 0;
  for (const gram of leftGrams) {
    if (rightGrams.has(gram)) intersection += 1;
  }
  return (2 * intersection) / (leftGrams.size + rightGrams.size);
}

function comparableCharacters(value) {
  const ignored = new Set("的了是在与和或等有为中后前要需可将并及则如若应由对把被让会能");
  return new Set([...normalizeText(value)].filter((character) => !ignored.has(character)));
}

export function scoreSubjectiveHeuristic(answer, referenceAnswer, points) {
  const normalizedAnswer = normalizeText(answer);
  if (normalizedAnswer === normalizeText(referenceAnswer)) return points;
  const referenceWithoutLabel = String(referenceAnswer).replace(/^正确答案[:：]\s*/, "");
  if (normalizedAnswer === normalizeText(referenceWithoutLabel)) return points;
  if (normalizedAnswer.length < 4) return 0;

  const referenceParts = String(referenceAnswer)
    .split(/(?:（\d+）|\(\d+\)|[；。])/)
    .map((part) => part.trim())
    .filter((part) => normalizeText(part).length >= 4);
  const parts = referenceParts.length ? referenceParts : [referenceAnswer];

  const partScores = parts.map((part) => {
    const normalizedPart = normalizeText(part);
    const answerGrams = comparableBigrams(answer);
    const partGrams = comparableBigrams(part);
    const matchedGrams = [...partGrams].filter((gram) => answerGrams.has(gram)).length;
    const coverage = partGrams.size ? matchedGrams / partGrams.size : 0;
    const answerCharacters = comparableCharacters(answer);
    const partCharacters = comparableCharacters(part);
    const characterCoverage = partCharacters.size
      ? [...partCharacters].filter((character) => answerCharacters.has(character)).length / partCharacters.size
      : 0;
    const numberTokens = part.match(/\d+(?:\.\d+)?(?:元|分钟|小时|天|年|次|张|w|W)?/g) || [];
    const requiredNumbers = numberTokens.filter((token) => normalizeText(token));
    const numbersMatched = requiredNumbers.length
      ? requiredNumbers.filter((token) => normalizedAnswer.includes(normalizeText(token))).length / requiredNumbers.length
      : 1;
    const similarity = diceSimilarity(answer, normalizedPart);
    const semanticCoverage = Math.min(1, coverage * 1.35 + similarity * 0.55 + characterCoverage * 0.25);
    return semanticCoverage * (0.75 + numbersMatched * 0.25);
  });

  const average = partScores.reduce((sum, value) => sum + value, 0) / partScores.length;
  return Number((points * average).toFixed(2));
}

function normalizedChoice(answer) {
  const values = Array.isArray(answer) ? answer : String(answer || "").split("");
  return [...new Set(values.map((value) => String(value).toUpperCase()).filter(Boolean))].sort();
}

function fillMatches(answer, acceptedAnswers) {
  const normalized = normalizeText(answer);
  return acceptedAnswers.some((accepted) => {
    const candidate = normalizeText(accepted);
    return normalized === candidate || (candidate.length >= 2 && normalized.includes(candidate));
  });
}

export function validateQuestionBank(questionBank, blueprint = EXAM_BLUEPRINT) {
  const questions = Array.isArray(questionBank?.questions) ? questionBank.questions : [];
  const ids = new Set();
  for (const question of questions) {
    if (!question.id || ids.has(question.id)) throw new Error(`题库存在重复或缺失 ID：${question.id || "未知"}`);
    ids.add(question.id);
  }
  for (const [type, count] of Object.entries(blueprint)) {
    const available = questions.filter((question) => question.type === type && question.enabled !== false).length;
    if (available < count) throw new Error(`${QUESTION_TYPE_LABELS[type]}不足：需要 ${count}，现有 ${available}`);
  }
  return true;
}

export function createExamQuestions(questionBank, blueprint = EXAM_BLUEPRINT, { previousQuestionIds = [] } = {}) {
  validateQuestionBank(questionBank, blueprint);
  const usageCounts = new Map();
  for (const questionId of previousQuestionIds) {
    usageCounts.set(questionId, (usageCounts.get(questionId) || 0) + 1);
  }
  const selected = [];
  for (const [type, count] of Object.entries(blueprint)) {
    const candidates = questionBank.questions.filter((question) => question.type === type && question.enabled !== false);
    const leastUsedFirst = shuffle(candidates).sort(
      (left, right) => (usageCounts.get(left.id) || 0) - (usageCounts.get(right.id) || 0),
    );
    selected.push(...leastUsedFirst.slice(0, count));
  }
  return selected.map((question, index) => ({ ...question, order: index + 1 }));
}

export function sanitizeQuestions(questions) {
  return questions.map(({ answer, acceptedAnswers, referenceAnswer, gradingCriteria, explanation, ...question }) => question);
}

export function sanitizeResultDetails(details = []) {
  return details.map(({ id, order, type, earned, maximum, correct }) => ({
    id,
    order,
    type,
    earned,
    maximum,
    correct,
  }));
}

export function gradeExam(questions, answers = {}, { subjectiveGrader = scoreSubjectiveHeuristic } = {}) {
  let earnedRaw = 0;
  let maximumRaw = 0;
  const details = [];

  for (const [questionIndex, question] of questions.entries()) {
    const submitted = answers[question.id] ?? "";
    const points = Number(question.points || 0);
    maximumRaw += points;
    let earned = 0;
    let correct = false;

    if (question.type === "single" || question.type === "multiple") {
      const expected = normalizedChoice(question.answer);
      const actual = normalizedChoice(submitted);
      correct = expected.join("") === actual.join("");
      earned = correct ? points : 0;
    } else if (question.type === "fill") {
      correct = fillMatches(submitted, question.acceptedAnswers || [question.answer]);
      earned = correct ? points : 0;
    } else if (question.type === "judge") {
      correct = String(submitted) === String(question.answer);
      earned = correct ? points : 0;
    } else {
      earned = subjectiveGrader(submitted, question.gradingCriteria || question.referenceAnswer || "", points, question);
      correct = earned >= points * 0.75;
    }

    earnedRaw += earned;
    details.push({
      id: question.id,
      order: question.order || questionIndex + 1,
      type: question.type,
      prompt: question.prompt,
      submitted,
      earned: Number(earned.toFixed(2)),
      maximum: points,
      correct,
      correctAnswer:
        question.type === "short" || question.type === "scenario"
          ? question.gradingCriteria || question.referenceAnswer
          : question.explanation || question.acceptedAnswers || question.answer,
    });
  }

  const score = maximumRaw ? Math.round((earnedRaw / maximumRaw) * 100) : 0;
  return {
    score,
    earnedRaw: Number(earnedRaw.toFixed(2)),
    maximumRaw,
    details,
  };
}
