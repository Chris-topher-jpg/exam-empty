import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("candidate payment view shows both configured payment QR codes", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(html, /东东数字ID/);
  assert.match(html, /id="savePaymentQr"/);
  assert.match(html, /payment-wechat\.jpg/);
  assert.match(html, /payment-alipay\.jpg/);
  assert.match(html, /微信支付/);
  assert.match(html, /支付宝/);
  assert.match(script, /paymentWechatQr/);
  assert.match(script, /paymentAlipayQr/);
  assert.doesNotMatch(script, /native-prepay/);
});
