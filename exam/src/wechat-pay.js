import crypto from "node:crypto";
import fs from "node:fs";
import { paymentExpiresAt } from "./payment-lifecycle.js";

const PREFIX = "ONBOARDING_EXAM_WECHAT_PAY_";

export function readWechatConfig(env = process.env) {
  const get = (name) => String(env[`${PREFIX}${name}`] || "").trim();
  const key = (name) => {
    if (get(`${name}_FILE`)) return fs.readFileSync(get(`${name}_FILE`), "utf8");
    if (get(`${name}_BASE64`)) return Buffer.from(get(`${name}_BASE64`), "base64").toString("utf8");
    return get(name).replace(/\\n/g, "\n");
  };
  return {
    mchId: get("MCH_ID"), appId: get("APP_ID"), apiV3Key: get("API_V3_KEY"),
    serialNo: get("MCH_SERIAL_NO"), publicKeyId: get("PLATFORM_PUBLIC_KEY_ID"),
    privateKey: key("PRIVATE_KEY"), publicKey: key("PLATFORM_PUBLIC_KEY"),
    publicUrl: String(env.ONBOARDING_EXAM_PUBLIC_URL || "").trim().replace(/\/$/, ""),
  };
}

export function validateWechatConfig(config) {
  const missing = [];
  const required = { mchId: "商户号", appId: "AppID", apiV3Key: "APIv3 密钥", serialNo: "商户证书序列号", publicKeyId: "微信支付公钥 ID", privateKey: "商户私钥", publicKey: "微信支付公钥", publicUrl: "公网 HTTPS 地址" };
  for (const [key, label] of Object.entries(required)) if (!config[key]) missing.push(label);
  if (config.apiV3Key && Buffer.byteLength(config.apiV3Key, "utf8") !== 32) missing.push("APIv3 密钥须为 32 字节");
  if (config.mchId && !/^\d{6,15}$/.test(config.mchId)) missing.push("商户号格式无效");
  if (config.appId && !/^wx[\da-f]{16}$/i.test(config.appId)) missing.push("AppID 格式无效");
  if (config.serialNo && !/^[\da-f]+$/i.test(config.serialNo)) missing.push("证书序列号格式无效");
  if (config.publicKeyId && !/^PUB_KEY_ID_\d+$/.test(config.publicKeyId)) missing.push("微信支付公钥 ID 格式无效");
  if (config.publicUrl) {
    try {
      const url = new URL(config.publicUrl);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/" || url.hostname === "localhost" || /^(127\.|\[?::1\]?$)/.test(url.hostname) || url.hostname.endsWith(".example.com")) throw new Error();
    } catch { missing.push("公网地址须为有效 HTTPS 域名且不含路径"); }
  }
  for (const [field, label, parse] of [["privateKey", "商户私钥", crypto.createPrivateKey], ["publicKey", "微信支付公钥", crypto.createPublicKey]]) {
    if (!config[field]) continue;
    try {
      const key = parse(config[field]);
      if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails.modulusLength < 2048) throw new Error();
    } catch { missing.push(`${label}须为有效 RSA 2048 位 PEM`); }
  }
  return { ready: missing.length === 0, missing };
}

export class WechatPay {
  constructor(config, { fetchImpl = globalThis.fetch, now = Date.now } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.now = now;
    this.status = validateWechatConfig(config);
  }

  authorization(method, pathname, body = "") {
    const timestamp = Math.floor(this.now() / 1000).toString();
    const nonce = crypto.randomBytes(16).toString("hex");
    const signature = crypto.sign("RSA-SHA256", Buffer.from(`${method}\n${pathname}\n${timestamp}\n${nonce}\n${body}\n`), this.config.privateKey).toString("base64");
    return `WECHATPAY2-SHA256-RSA2048 mchid="${this.config.mchId}",nonce_str="${nonce}",signature="${signature}",timestamp="${timestamp}",serial_no="${this.config.serialNo}"`;
  }

  verify(headers, rawBody) {
    const get = (name) => typeof headers.get === "function" ? headers.get(name) : headers[name.toLowerCase()];
    const timestamp = get("Wechatpay-Timestamp"), nonce = get("Wechatpay-Nonce"), signature = get("Wechatpay-Signature"), serial = get("Wechatpay-Serial");
    if (!timestamp || !nonce || !signature || serial !== this.config.publicKeyId) throw new Error("微信支付签名头或公钥 ID 无效");
    if (!/^\d+$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp)) || Math.abs(Math.floor(this.now() / 1000) - Number(timestamp)) > 300) throw new Error("微信支付签名时间无效");
    if (!crypto.verify("RSA-SHA256", Buffer.from(`${timestamp}\n${nonce}\n${rawBody}\n`), this.config.publicKey, Buffer.from(signature, "base64"))) throw new Error("微信支付验签失败");
  }

  async request(method, pathname, data) {
    if (!this.status.ready) throw new Error("微信收款尚未开通，请联系考官或使用答题码");
    const body = data === undefined ? "" : JSON.stringify(data);
    let response;
    try {
      response = await this.fetch(`https://api.mch.weixin.qq.com${pathname}`, {
        method, headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: this.authorization(method, pathname, body), "Wechatpay-Serial": this.config.publicKeyId },
        ...(body ? { body } : {}), signal: AbortSignal.timeout(10_000),
      });
      const rawBody = await response.text();
      // Verify the original bytes before trusting any response fields, including errors.
      this.verify(response.headers, rawBody);
      const payload = rawBody ? JSON.parse(rawBody) : {};
      if (!response.ok) {
        const error = new Error("微信支付请求失败，请稍后重试");
        error.code = typeof payload.code === "string" ? payload.code : "WECHAT_ERROR";
        throw error;
      }
      return payload;
    } catch (error) {
      if (error.name === "TimeoutError" || error.name === "AbortError" || error instanceof TypeError) throw new Error("微信支付连接超时，请刷新状态后重试");
      throw error;
    }
  }

  async prepay(payment, description) {
    const payload = await this.request("POST", "/v3/pay/transactions/native", {
      appid: this.config.appId, mchid: this.config.mchId,
      description: [...description].slice(0, 40).join(""), out_trade_no: payment.paymentNo,
      time_expire: new Date(paymentExpiresAt(payment)).toISOString(),
      notify_url: `${this.config.publicUrl}/api/payment/wechat-notify`,
      amount: { total: Math.round(payment.amount * 100), currency: "CNY" },
    });
    if (typeof payload.code_url !== "string" || !/^weixin:\/\/wxpay\/bizpayurl\?/.test(payload.code_url) || payload.code_url.length > 1024) throw new Error("微信支付二维码无效");
    return payload.code_url;
  }

  query(paymentNo) {
    return this.request("GET", `/v3/pay/transactions/out-trade-no/${encodeURIComponent(paymentNo)}?mchid=${this.config.mchId}`);
  }

  close(paymentNo) {
    return this.request("POST", `/v3/pay/transactions/out-trade-no/${encodeURIComponent(paymentNo)}/close`, { mchid: this.config.mchId });
  }

  notification(headers, rawBody) {
    if (!this.status.ready) throw new Error("微信支付配置不完整");
    this.verify(headers, rawBody);
    const notification = JSON.parse(rawBody);
    if (notification.event_type !== "TRANSACTION.SUCCESS" || notification.resource?.algorithm !== "AEAD_AES_256_GCM" || notification.resource.original_type !== "transaction") throw new Error("微信支付通知类型无效");
    const resource = notification.resource;
    const encrypted = Buffer.from(String(resource.ciphertext || ""), "base64");
    if (encrypted.length < 17) throw new Error("微信支付加密通知无效");
    const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(this.config.apiV3Key, "utf8"), resource.nonce);
    if (typeof resource.associated_data === "string") decipher.setAAD(Buffer.from(resource.associated_data, "utf8"));
    decipher.setAuthTag(encrypted.subarray(-16));
    return JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString("utf8"));
  }

  validateTransaction(transaction, payment) {
    if (transaction.mchid !== this.config.mchId || transaction.appid !== this.config.appId || transaction.out_trade_no !== payment.paymentNo) throw new Error("微信支付订单信息不匹配");
    // WeChat omits trade_type on some unpaid orders; successful transactions must include it.
    if ((transaction.trade_state === "SUCCESS" || transaction.trade_type !== undefined) && transaction.trade_type !== "NATIVE") throw new Error("微信支付类型不匹配");
    // CLOSED, NOTPAY and other non-successful query states may omit amount/currency.
    // They can never unlock an exam, so only successful transactions need payment validation.
    if (transaction.trade_state !== "SUCCESS") return;
    if (transaction.amount?.total !== Math.round(payment.amount * 100) || transaction.amount?.currency !== "CNY" || payment.amount <= 0) throw new Error("微信支付金额或币种不匹配");
    if (!transaction.transaction_id || !Number.isFinite(Date.parse(transaction.success_time))) throw new Error("微信支付成功信息无效");
  }
}

export function applyWechatTransaction(client, transaction, payment) {
  client.validateTransaction(transaction, payment);
  if (transaction.trade_state !== "SUCCESS") return false;
  if (payment.paymentChannel !== "wechat_native") throw new Error("付款单未使用微信支付");
  if (payment.wechatTransactionId && payment.wechatTransactionId !== transaction.transaction_id) throw new Error("微信支付流水不匹配");
  if (payment.status === "paid" && payment.wechatTransactionId === transaction.transaction_id) return false;
  payment.status = "paid";
  payment.confirmedAt ||= new Date(client.now()).toISOString();
  payment.paidAt = transaction.success_time;
  payment.wechatTransactionId = transaction.transaction_id;
  payment.codeUrl = null;
  payment.canceledAt = null;
  payment.cancelReason = null;
  return true;
}
