import assert from "node:assert/strict";
import crypto from "node:crypto";
import { test } from "node:test";
import { WechatPay, applyWechatTransaction, validateWechatConfig } from "../src/wechat-pay.js";

const merchant = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const platform = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const now = Date.now();
const config = {
  mchId: "1749813950", appId: "wx0b31e1882e06de07", apiV3Key: "x".repeat(32), serialNo: "AABBCC",
  publicKeyId: "PUB_KEY_ID_123", publicUrl: "https://jqcnexam.yeshuyu.com",
  privateKey: merchant.privateKey.export({ type: "pkcs8", format: "pem" }),
  publicKey: platform.publicKey.export({ type: "spki", format: "pem" }),
};
const payment = () => ({ paymentNo: "JQCNPAYTEST", amount: 20, paymentChannel: "wechat_native", status: "pending", createdAt: new Date(now).toISOString() });
const transaction = (overrides = {}) => ({
  mchid: config.mchId, appid: config.appId, out_trade_no: "JQCNPAYTEST", trade_type: "NATIVE", trade_state: "SUCCESS",
  amount: { total: 2000, currency: "CNY" }, transaction_id: "wx-success-1", success_time: new Date(now).toISOString(), ...overrides,
});
function signedHeaders(raw, timestamp = Math.floor(now / 1000).toString()) {
  const nonce = "notification-nonce";
  return {
    "wechatpay-timestamp": timestamp, "wechatpay-nonce": nonce, "wechatpay-serial": config.publicKeyId,
    "wechatpay-signature": crypto.sign("RSA-SHA256", Buffer.from(`${timestamp}\n${nonce}\n${raw}\n`), platform.privateKey).toString("base64"),
  };
}
function encryptedNotification(data) {
  const nonce = "123456789012", associated_data = "transaction";
  const cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(config.apiV3Key), nonce);
  cipher.setAAD(Buffer.from(associated_data));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final(), cipher.getAuthTag()]).toString("base64");
  return JSON.stringify({ event_type: "TRANSACTION.SUCCESS", resource: { algorithm: "AEAD_AES_256_GCM", original_type: "transaction", nonce, associated_data, ciphertext } });
}

test("configuration requires a public key ID, valid keys, a 32-byte secret and HTTPS origin", () => {
  assert.equal(validateWechatConfig(config).ready, true);
  for (const overrides of [{ publicKeyId: "" }, { apiV3Key: "中".repeat(32) }, { publicUrl: "http://localhost:3000" }, { publicUrl: "https://host.test/path" }, { privateKey: "invalid" }, { publicKey: "invalid" }]) {
    assert.equal(validateWechatConfig({ ...config, ...overrides }).ready, false);
  }
});

test("Native order has correct amount, callback and verifiable merchant signature", async () => {
  const client = new WechatPay(config, { now: () => now, fetchImpl: async (url, options) => {
    assert.equal(url, "https://api.mch.weixin.qq.com/v3/pay/transactions/native");
    const fields = Object.fromEntries([...options.headers.Authorization.matchAll(/(\w+)="([^"]+)"/g)].map((m) => [m[1], m[2]]));
    assert.equal(fields.mchid, config.mchId);
    assert.equal(fields.serial_no, config.serialNo);
    assert.equal(options.headers["Wechatpay-Serial"], config.publicKeyId);
    const message = `POST\n/v3/pay/transactions/native\n${fields.timestamp}\n${fields.nonce_str}\n${options.body}\n`;
    assert.ok(crypto.verify("RSA-SHA256", Buffer.from(message), merchant.publicKey, Buffer.from(fields.signature, "base64")));
    const order = JSON.parse(options.body);
    assert.equal(order.amount.total, 2000);
    assert.equal(order.notify_url, "https://jqcnexam.yeshuyu.com/api/payment/wechat-notify");
    assert.equal(Date.parse(order.time_expire) - now, 30 * 60_000);
    const raw = JSON.stringify({ code_url: "weixin://wxpay/bizpayurl?pr=test" });
    return new Response(raw, { headers: signedHeaders(raw) });
  } });
  assert.equal(await client.prepay(payment(), "考试第2次"), "weixin://wxpay/bizpayurl?pr=test");
});

test("forged response, wrong key ID, stale and nonnumeric signature timestamps are rejected", async () => {
  const client = new WechatPay(config, { now: () => now });
  const raw = JSON.stringify({ code_url: "weixin://wxpay/bizpayurl?pr=test" });
  assert.doesNotThrow(() => client.verify(signedHeaders(raw), raw));
  for (const headers of [signedHeaders(raw, "not-a-number"), signedHeaders(raw, "1"), { ...signedHeaders(raw), "wechatpay-serial": "PUB_KEY_ID_OTHER" }, { ...signedHeaders(raw), "wechatpay-signature": "forged" }]) assert.throws(() => client.verify(headers, raw));
  client.fetch = async () => new Response(raw, { headers: signedHeaders("different body") });
  await assert.rejects(() => client.prepay(payment(), "考试"), /验签/);
});

test("signed notification decrypts and updates payment only once, including a late notification", () => {
  const client = new WechatPay(config, { now: () => now });
  const raw = encryptedNotification(transaction());
  const verified = client.notification(signedHeaders(raw), raw);
  const order = { ...payment(), status: "canceled", cancelReason: "payment_timeout" };
  assert.equal(applyWechatTransaction(client, verified, order), true);
  assert.equal(order.status, "paid");
  assert.equal(order.wechatTransactionId, "wx-success-1");
  assert.equal(applyWechatTransaction(client, verified, order), false);
  assert.throws(() => client.notification(signedHeaders(raw), raw.replace(/ciphertext":"./, 'ciphertext":"A')), /验签/);
});

test("wrong merchant, AppID, amount, currency, order or transaction cannot unlock an exam", () => {
  const client = new WechatPay(config, { now: () => now });
  for (const overrides of [{ mchid: "wrong" }, { appid: "wrong" }, { out_trade_no: "wrong" }, { trade_type: "JSAPI" }, { amount: { total: 1, currency: "CNY" } }, { amount: { total: 2000, currency: "USD" } }, { transaction_id: "" }]) {
    const order = payment();
    assert.throws(() => applyWechatTransaction(client, transaction(overrides), order));
    assert.equal(order.status, "pending");
  }
  assert.equal(applyWechatTransaction(client, transaction({ trade_state: "NOTPAY" }), payment()), false);
});

test("signed query errors are safe to classify; unsigned errors are rejected", async () => {
  const raw = JSON.stringify({ code: "ORDER_NOT_EXIST", message: "不存在" });
  const client = new WechatPay(config, { now: () => now, fetchImpl: async () => new Response(raw, { status: 404, headers: signedHeaders(raw) }) });
  await assert.rejects(() => client.query("test"), (error) => error.code === "ORDER_NOT_EXIST");
  client.fetch = async () => new Response(raw, { status: 404 });
  await assert.rejects(() => client.query("test"), /签名头/);
});
