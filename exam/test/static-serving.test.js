import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

let baseUrl;
let server;
let directory;
let adminUsersPath;
let questionBankPath;

before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "jqdj-static-server-"));
  adminUsersPath = path.join(directory, "admin-users.json");
  questionBankPath = path.join(directory, "question-bank.json");
  const blueprint = { single: 20, multiple: 2, fill: 0, judge: 8, short: 0, scenario: 0 };
  const questions = Object.entries(blueprint).flatMap(([type, count]) => Array.from({ length: count }, (_, index) => ({
    id: `${type}-${index + 1}`,
    type,
    prompt: `fixture ${type} ${index + 1}`,
    points: 2,
    ...(type === "single" || type === "multiple" ? { options: [{ key: "A", text: "A" }, { key: "B", text: "B" }], answer: ["A"] } : {}),
    ...(type === "fill" ? { answer: "答案", acceptedAnswers: ["答案"] } : {}),
    ...(type === "judge" ? { answer: "true" } : {}),
    ...(type === "short" || type === "scenario" ? { referenceAnswer: "这是一个足够长的参考答案。" } : {}),
  })));
  fs.writeFileSync(questionBankPath, JSON.stringify({ questions }));
  process.env.ONBOARDING_EXAM_ADMIN_USERS_PATH = adminUsersPath;
  process.env.ONBOARDING_EXAM_QUESTION_BANK_PATH = questionBankPath;
  ({ server } = await import("../server.js"));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  delete process.env.ONBOARDING_EXAM_ADMIN_USERS_PATH;
  delete process.env.ONBOARDING_EXAM_QUESTION_BANK_PATH;
  fs.rmSync(directory, { recursive: true, force: true });
});

test("ES modules are served with a JavaScript MIME type", async () => {
  const response = await fetch(`${baseUrl}/qrcode-generator.mjs`);

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /^text\/javascript\b/i);
});

test("serving public assets does not create administrator state", async () => {
  const response = await fetch(`${baseUrl}/admin`);
  assert.equal(response.status, 200);
  assert.equal(fs.existsSync(adminUsersPath), false);
});

test("payment QR images are served as JPEG assets", async () => {
  for (const asset of ["payment-wechat.jpg", "payment-alipay.jpg"]) {
    const response = await fetch(`${baseUrl}/${asset}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") || "", /^image\/jpeg\b/i);
  }
});

test("deployment health is public, uncached and does not initialize administrator state", async () => {
  const response = await fetch(`${baseUrl}/api/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(Object.keys(await response.json()).sort(), ["ok", "revision", "service"]);
  assert.equal(fs.existsSync(adminUsersPath), false);
});
