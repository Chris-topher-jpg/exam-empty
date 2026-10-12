// A short integration check, not a sustained capacity benchmark. All writes use
// a temporary directory; no production records or external AI calls are made.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const count = Number(process.argv[2] || 20);
assert.ok(Number.isInteger(count) && count >= 1 && count <= 100);
const questionBank = path.resolve(process.env.ONBOARDING_EXAM_QUESTION_BANK_PATH || 'data/question-bank.json');
assert.ok(fs.existsSync(questionBank), 'Question bank required');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'bibiniao-smoke-'));
Object.assign(process.env, {
  ONBOARDING_EXAM_STATE_PATH: path.join(directory, 'state.json'),
  ONBOARDING_EXAM_CONFIG_PATH: path.join(directory, 'config.json'),
  ONBOARDING_EXAM_ADMIN_USERS_PATH: path.join(directory, 'admin-users.json'),
  ONBOARDING_EXAM_QUESTION_BANK_PATH: questionBank,
  ADMIN_PASSWORD: 'Only_an_isolated_smoke_fixture_2026',
  DEMO_AUTO_PAY: '0',
  DEEPSEEK_API_KEY: '',
});
let server;
try {
  ({ server } = await import('../server.js'));
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  async function request(route, body, token) {
    const response = await fetch(`${baseUrl}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = await response.json();
    assert.ok(response.ok, `${route}: ${response.status} ${data.error || ''}`);
    return data;
  }
  const began = performance.now();
  const candidates = Array.from({ length: count }, (_, index) => ({ candidateName: `隔离测试${index}`, candidateId: `isolated-${index}` }));
  const payments = await Promise.all(candidates.map(candidate => request('/api/payment/request', candidate)));
  assert.ok(payments.every(payment => payment.amount === 0 && payment.status === 'paid'));
  const exams = await Promise.all(payments.map(payment => request('/api/exams/start', { paymentToken: payment.token })));
  const papers = await Promise.all(exams.map(exam => request(`/api/exams/${exam.id}?token=${exam.accessToken}`)));
  assert.ok(papers.every(paper => paper.questions.length === 30));
  const opened = performance.now();
  const submitTimes = [];
  const results = await Promise.all(exams.map(async (exam, index) => {
    const start = performance.now();
    const answers = Object.fromEntries(papers[index].questions.map(question => [question.id,
      question.type === 'judge' ? 'true' : question.type === 'single' ? 'A' : '按照俱乐部规范进行考核并按要求处理。']));
    const result = await request(`/api/exams/${exam.id}/submit`, { accessToken: exam.accessToken, answers });
    submitTimes.push(performance.now() - start);
    return result;
  }));
  assert.equal(new Set(results.map(result => result.id)).size, count);
  const state = JSON.parse(fs.readFileSync(process.env.ONBOARDING_EXAM_STATE_PATH, 'utf8'));
  assert.equal(state.results.length, count);
  assert.equal(state.exams.filter(exam => exam.status === 'submitted').length, count);
  const login = await request('/api/admin/login', { username: 'admin', password: process.env.ADMIN_PASSWORD });
  const secondPayment = await request('/api/payment/request', candidates[0]);
  assert.equal(secondPayment.amount, 20);
  assert.equal(secondPayment.status, 'pending');
  await request(`/api/admin/payments/${secondPayment.id}/confirm`, {}, login.token);
  const secondExam = await request('/api/exams/start', { paymentToken: secondPayment.token });
  assert.ok(secondExam.id);
  submitTimes.sort((a, b) => a - b);
  console.log(JSON.stringify({
    candidates: count, successfulSubmissions: results.length, paidRetryFlow: 'passed',
    openBatchMs: Math.round(opened - began),
    submitP95Ms: Math.round(submitTimes[Math.ceil(count * 0.95) - 1]),
    rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    externalAi: false, storage: 'isolated temporary directory',
  }, null, 2));
} finally {
  if (server?.listening) await new Promise(resolve => server.close(resolve));
  fs.rmSync(directory, { recursive: true, force: true });
}
