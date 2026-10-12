import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

const merchant = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const platform = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const realFetch = globalThis.fetch;
let server, baseUrl, directory, nativeCalls = 0, closeCalls = 0, queryPaid = false;
let createdOrder, timeoutNext = false;
const mchId = "1749813950", appId = "wx0b31e1882e06de07", apiV3Key = "x".repeat(32), publicKeyId = "PUB_KEY_ID_123";
function headers(raw) {
  const timestamp = Math.floor(Date.now() / 1000).toString(), nonce = "signed-test";
  return {
    "wechatpay-timestamp": timestamp, "wechatpay-nonce": nonce, "wechatpay-serial": publicKeyId,
    "wechatpay-signature": crypto.sign("RSA-SHA256", Buffer.from(`${timestamp}\n${nonce}\n${raw}\n`), platform.privateKey).toString("base64"),
  };
}
function success(order = createdOrder, overrides = {}) {
  return { mchid: mchId, appid: appId, out_trade_no: order.out_trade_no, trade_type: "NATIVE", trade_state: "SUCCESS", transaction_id: "wx-test-1", success_time: new Date().toISOString(), amount: order.amount, ...overrides };
}
function notification(transaction) {
  const nonce = "123456789012", associated_data = "transaction";
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(apiV3Key), nonce);
  cipher.setAAD(Buffer.from(associated_data));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(transaction)), cipher.final(), cipher.getAuthTag()]).toString("base64");
  const raw = JSON.stringify({ event_type: "TRANSACTION.SUCCESS", resource: { algorithm: "AEAD_AES_256_GCM", original_type: "transaction", nonce, associated_data, ciphertext } });
  return { raw, headers: headers(raw) };
}
async function request(route, body, token) {
  const response = await realFetch(`${baseUrl}${route}`, {
    ...(body !== undefined ? { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  });
  return { status: response.status, data: await response.json() };
}
async function candidate(id) {
  const data = { candidateName: "支付测试", candidateId: id };
  const free = await request("/api/payment/request", data);
  assert.equal(free.data.amount, 0);
  await request("/api/exams/start", { paymentToken: free.data.token });
  return (await request("/api/payment/request", data)).data;
}

before(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "jqcn-wechat-api-"));
  for (const [name, value] of Object.entries({ MCH_ID: mchId, APP_ID: appId, API_V3_KEY: apiV3Key, MCH_SERIAL_NO: "AABB", PLATFORM_PUBLIC_KEY_ID: publicKeyId, PRIVATE_KEY_BASE64: Buffer.from(merchant.privateKey.export({ type: "pkcs8", format: "pem" })).toString("base64"), PLATFORM_PUBLIC_KEY_BASE64: Buffer.from(platform.publicKey.export({ type: "spki", format: "pem" })).toString("base64") })) process.env[`ONBOARDING_EXAM_WECHAT_PAY_${name}`] = value;
  process.env.ONBOARDING_EXAM_PUBLIC_URL = "https://jqcnexam.yeshuyu.com";
  process.env.ADMIN_PASSWORD = "test-wechat-owner-2026";
  process.env.DEMO_AUTO_PAY = "0";
  for (const name of ["STATE", "CONFIG", "ADMIN_USERS"]) process.env[`ONBOARDING_EXAM_${name}_PATH`] = path.join(directory, `${name}.json`);
  globalThis.fetch = async (url, options) => {
    assert.ok(url.startsWith("https://api.mch.weixin.qq.com/"));
    if (url.endsWith("/close")) {
      closeCalls++;
      return new Response(null, { status: 204, headers: headers("") });
    }
    if (url.endsWith("/native")) {
      nativeCalls++;
      createdOrder = JSON.parse(options.body);
      if (timeoutNext) { timeoutNext = false; throw new DOMException("timeout", "TimeoutError"); }
      const raw = JSON.stringify({ code_url: "weixin://wxpay/bizpayurl?pr=mock-api" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(raw, { headers: headers(raw) });
    }
    const raw = JSON.stringify(success(createdOrder, queryPaid ? {} : { trade_state: "NOTPAY", trade_type: undefined, transaction_id: undefined, success_time: undefined }));
    return new Response(raw, { headers: headers(raw) });
  };
  ({ server } = await import("../server.js"));
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  globalThis.fetch = realFetch;
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(directory, { recursive: true, force: true });
});

test("concurrent prepay reuses one Native order and forged notifications cannot unlock it", async () => {
  const payment = await candidate("wechat-notify");
  const orders = await Promise.all(Array.from({ length: 6 }, () => request("/api/payment/native-prepay", { token: payment.token })));
  assert.equal(nativeCalls, 1);
  assert.ok(orders.every((item) => item.status === 200 && item.data.codeUrl));
  const login = await request("/api/admin/login", { username: "admin", password: "test-wechat-owner-2026" });
  assert.equal((await request(`/api/admin/payments/${payment.id}/confirm`, {}, login.data.token)).status, 409);
  const invalid = notification(success(createdOrder, { amount: { total: 1, currency: "CNY" } }));
  const rejected = await realFetch(`${baseUrl}/api/payment/wechat-notify`, { method: "POST", body: invalid.raw, headers: invalid.headers });
  assert.equal(rejected.status, 400);
  assert.equal((await request("/api/exams/start", { paymentToken: payment.token })).status, 403);
  const valid = notification(success());
  for (let repeat = 0; repeat < 2; repeat++) {
    const response = await realFetch(`${baseUrl}/api/payment/wechat-notify`, { method: "POST", body: valid.raw, headers: valid.headers });
    assert.equal(response.status, 200);
  }
  const status = await request(`/api/payment/status/${payment.token}`);
  assert.equal(status.data.status, "paid");
  const started = await request("/api/exams/start", { paymentToken: payment.token });
  assert.equal(started.status, 201);
  assert.equal((await request("/api/exams/start", { paymentToken: payment.token })).data.id, started.data.id);
});

test("query recovers a successful payment when a prepay request timed out", async () => {
  const payment = await candidate("wechat-timeout");
  timeoutNext = true;
  assert.equal((await request("/api/payment/native-prepay", { token: payment.token })).status, 503);
  queryPaid = true;
  const recovered = await request(`/api/payment/status/${payment.token}`);
  assert.equal(recovered.data.status, "paid");
  const orderCount = nativeCalls;
  assert.equal((await request("/api/payment/native-prepay", { token: payment.token })).data.status, "paid");
  assert.equal(nativeCalls, orderCount);
});

test("redeeming an answer code closes the unpaid Native order before granting an alternative", async () => {
  queryPaid = false;
  const payment = await candidate("wechat-close-for-code");
  await request("/api/payment/native-prepay", { token: payment.token });
  const login = await request("/api/admin/login", { username: "admin", password: "test-wechat-owner-2026" });
  const code = await request("/api/admin/answer-codes", { usageLimit: 1, validHours: 1 }, login.data.token);
  const redeemed = await request("/api/answer-codes/redeem", { candidateName: "支付测试", candidateId: "wechat-close-for-code", code: code.data.answerCode.code });
  assert.equal(redeemed.status, 201);
  assert.equal(redeemed.data.paymentChannel, "answer_code");
  assert.equal(closeCalls, 1);
  const canceled = await request(`/api/payment/status/${payment.token}`);
  assert.equal(canceled.data.status, "canceled");
  assert.equal(canceled.data.codeUrl, null);
});
