import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXAM_BLUEPRINT, createExamQuestions, gradeExam, sanitizeQuestions } from "../src/exam-engine.js";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const bank = JSON.parse(fs.readFileSync(path.join(root, "content", "question-bank.json"), "utf8"));
let server;
let directory;
let baseUrl;
let adminToken;

async function request(route, body, token) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json() };
}

before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "jqcn-exam-test-"));
  Object.assign(process.env, {
    ONBOARDING_EXAM_STATE_PATH: path.join(directory, "state.json"),
    ONBOARDING_EXAM_CONFIG_PATH: path.join(directory, "config.json"),
    ONBOARDING_EXAM_ADMIN_USERS_PATH: path.join(directory, "admin-users.json"),
    ONBOARDING_EXAM_QUESTION_BANK_PATH: path.join(directory, "question-bank.json"),
    ADMIN_PASSWORD: "Isolated_Exam_Test_2026", DEEPSEEK_API_KEY: "", DEMO_AUTO_PAY: "0",
  });
  fs.writeFileSync(process.env.ONBOARDING_EXAM_QUESTION_BANK_PATH, JSON.stringify(bank));
  ({ server } = await import("../server.js"));
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  const login = await request("/api/admin/login", { username: "admin", password: "Isolated_Exam_Test_2026" });
  adminToken = login.data.token;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  fs.rmSync(directory, { recursive: true, force: true });
});

test("spreadsheet produces 30 distinct questions worth exactly 100 points", () => {
  assert.equal(bank.sourceDocument, "机枪纯女文考.xlsx");
  assert.deepEqual(EXAM_BLUEPRINT, bank.examConfig.blueprint);
  const exam = createExamQuestions(bank);
  assert.equal(exam.length, 30);
  assert.equal(new Set(exam.map((question) => question.id)).size, 30);
  assert.equal(exam.reduce((sum, question) => sum + question.points, 0), 100);
  for (const [type, count] of [["judge", 8], ["single", 20], ["multiple", 2]]) {
    assert.equal(exam.filter((question) => question.type === type).length, count);
    assert.ok(exam.filter((question) => question.type === type).every((question) => question.points === (type === "multiple" ? 8 : 3)));
  }
  assert.equal(gradeExam(exam, Object.fromEntries(exam.map((question) => [question.id, question.answer]))).score, 100);
  assert.equal(gradeExam(exam, {}).score, 0);
  for (const question of sanitizeQuestions(exam)) {
    assert.equal("answer" in question, false);
    assert.equal("explanation" in question, false);
  }
});

test("multiple choice awards eight points only for the complete correct set", () => {
  const question = bank.questions.find((item) => item.type === "multiple");
  for (const answer of [[], ["A"], ["A", "B"], ["A", "B", "D"], ["A", "B", "C", "D"]]) {
    assert.equal(gradeExam([question], { [question.id]: answer }).earnedRaw, 0);
  }
  assert.equal(gradeExam([question], { [question.id]: ["C", "A", "B"] }).earnedRaw, 8);
});

test("configured exams retain the highest score and certificate through a lower retake and review", async () => {
  const config = (await request("/api/config")).data;
  assert.equal(config.clubName, "机枪纯女电竞");
  assert.equal(config.examMinutes, 18);
  assert.equal(config.passScore, 85);
  assert.equal(config.maxAttempts, 6);
  assert.equal(config.scorePolicy, "highest");
  const candidate = { candidateName: "配置测试", candidateId: "JQCN-CONFIG-TEST" };
  const code = await request("/api/admin/answer-codes", { usageLimit: 6, validHours: 1 }, adminToken);
  const results = [];
  for (const target of [85, 84, 100]) {
    const payment = await request("/api/answer-codes/redeem", { ...candidate, code: code.data.answerCode.code });
    assert.equal(payment.status, 201);
    const started = await request("/api/exams/start", { paymentToken: payment.data.token });
    assert.equal(started.status, 201);
    const exam = (await request(`/api/exams/${started.data.id}?token=${started.data.accessToken}`)).data;
    assert.ok(new Date(exam.expiresAt).getTime() - Date.now() > 17.8 * 60_000);
    const answers = Object.fromEntries(bank.questions.map((question) => [question.id, question.answer]));
    const omitted = target === 85 ? bank.questions.filter((item) => item.points === 3).slice(0, 5)
      : target === 84 ? bank.questions.filter((item) => item.type === "multiple") : [];
    for (const question of omitted) delete answers[question.id];
    const result = await request(`/api/exams/${exam.id}/submit`, { accessToken: started.data.accessToken, answers });
    assert.equal(result.status, 201);
    assert.equal(result.data.finalScore, target);
    assert.equal(result.data.passed, target >= 85);
    assert.equal(result.data.highestScore, target === 84 ? 85 : target);
    if (target === 84) {
      assert.equal(result.data.highestPassed, true);
      assert.equal(result.data.highestCertificateId, results[0].certificateId);
    }
    results.push(result.data);
  }
  let status = await request("/api/candidate/status", candidate);
  assert.equal(status.data.highestScore, 100);
  assert.equal(status.data.attemptsRemaining, 3);
  const reviewed = await request(`/api/admin/results/${results[2].id}/review`, { finalScore: 80 }, adminToken);
  assert.equal(reviewed.data.highestScore, 85);
  assert.equal(reviewed.data.highestCertificateId, results[0].certificateId);
  assert.equal((await request(`/api/certificates/${results[2].certificateId}`)).status, 404);
  status = await request("/api/candidate/status", candidate);
  assert.equal(status.data.highestScore, 85);
});
