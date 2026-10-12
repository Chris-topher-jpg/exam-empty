import assert from "node:assert/strict";
import { test } from "node:test";

import { expirePendingPayment, paymentExpiresAt } from "../src/payment-lifecycle.js";

test("pending payment is canceled after thirty minutes", () => {
  const payment = { status: "pending", createdAt: "2026-08-25T10:00:00.000Z", codeUrl: "wxpay://example" };
  const changed = expirePendingPayment(payment, new Date("2026-08-25T10:30:00.001Z").getTime());
  assert.equal(changed, true);
  assert.equal(payment.status, "canceled");
  assert.equal(payment.codeUrl, null);
  assert.equal(payment.cancelReason, "payment_timeout");
});

test("paid payment and active pending payment are preserved", () => {
  const pending = { status: "pending", createdAt: "2026-08-25T10:00:00.000Z" };
  const paid = { status: "paid", createdAt: "2026-08-25T09:00:00.000Z" };
  assert.equal(expirePendingPayment(pending, new Date("2026-08-25T10:29:59.000Z").getTime()), false);
  assert.equal(expirePendingPayment(paid, new Date("2026-08-25T12:00:00.000Z").getTime()), false);
  assert.equal(paymentExpiresAt(pending), new Date("2026-08-25T10:30:00.000Z").getTime());
});
