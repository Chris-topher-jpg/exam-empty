import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readPublic = (name) => fs.readFileSync(path.join(root, "public", name), "utf8");

test("payment polling stays silent and manual refresh uses stable loading state", () => {
  const script = readPublic("app.js");
  assert.match(script, /refreshPayment\(\{ interactive = false \} = \{\}\)/);
  assert.match(script, /setInterval\(\(\) => void refreshPayment\(\), 5000\)/);
  assert.match(script, /classList\.add\('loading'\)/);
  assert.doesNotMatch(script, /button\.textContent = '正在查询付款状态/);
});

test("candidate result page displays paper order instead of internal question ID", () => {
  const script = readPublic("result.js");
  assert.match(script, /第 \$\{item\.order \|\| index \+ 1\} 题/);
  assert.doesNotMatch(script, /escapeHtml\(item\.id\)/);
});

test("candidate can redeem an answer code and start without payment", () => {
  const html = readPublic("index.html");
  const script = readPublic("app.js");
  assert.match(html, /id="answerCode"/);
  assert.match(html, /id="redeemAnswerCodeButton"/);
  assert.match(script, /\/api\/answer-codes\/redeem/);
  assert.match(script, /await beginExam\(button, \$\('#candidateStatus'\)\)/);
});

test("candidate can resume an active exam and retain local answers after closing the page", () => {
  const html = readPublic("index.html");
  const appScript = readPublic("app.js");
  const examScript = readPublic("exam.js");
  assert.match(html, /id="resumeExamView"/);
  assert.match(html, /id="resumeExamButton"/);
  assert.match(appScript, /localStorage\.getItem\('jlb\.activeExam'\)/);
  assert.match(appScript, /\/api\/exams\/\$\{encodeURIComponent\(saved\.id\)\}/);
  assert.match(examScript, /localStorage\.setItem\('jlb\.activeExam'/);
  assert.match(examScript, /answers:\s*examState\.answers/);
});

test("candidate submission retries once after a transient failure", () => {
  const script = readPublic("exam.js");
  assert.match(script, /for \(let attempt = 0; attempt < 2; attempt \+= 1\)/);
  assert.match(script, /setTimeout\(resolve, 1200\)/);
  assert.match(script, /考试时间已结束/);
});
