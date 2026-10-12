import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("candidate payment view uses an order QR and never exposes legacy collection images", () => {
  const html = fs.readFileSync(path.join(root, "public", "index.html"), "utf8");
  const script = fs.readFileSync(path.join(root, "public", "app.js"), "utf8");
  assert.match(html, /东东数字ID/);
  assert.match(html, /id="savePaymentQr"/);
  assert.doesNotMatch(html, /payment-wechat\.jpg|payment-alipay\.jpg/);
  assert.match(html, /微信支付/);
  assert.match(script, /paymentWechatQr/);
  assert.doesNotMatch(script, /payment-wechat\.jpg|payment-alipay\.jpg/);
  assert.match(script, /native-prepay/);
});
