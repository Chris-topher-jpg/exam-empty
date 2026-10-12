export const DEFAULT_PAYMENT_TTL_MS = 30 * 60_000;

export function paymentExpiresAt(payment, ttlMs = DEFAULT_PAYMENT_TTL_MS) {
  if (payment.expiresAt) return new Date(payment.expiresAt).getTime();
  return new Date(payment.createdAt).getTime() + ttlMs;
}

export function expirePendingPayment(payment, now = Date.now(), ttlMs = DEFAULT_PAYMENT_TTL_MS) {
  if (payment.status !== "pending") return false;
  const expiresAt = paymentExpiresAt(payment, ttlMs);
  if (!Number.isFinite(expiresAt) || expiresAt > now) return false;
  payment.status = "canceled";
  payment.expiresAt = new Date(expiresAt).toISOString();
  payment.canceledAt = new Date(now).toISOString();
  payment.cancelReason = "payment_timeout";
  payment.codeUrl = null;
  return true;
}
