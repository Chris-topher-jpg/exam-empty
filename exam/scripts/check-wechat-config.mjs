import { readWechatConfig, validateWechatConfig } from "../src/wechat-pay.js";

try {
  const status = validateWechatConfig(readWechatConfig());
  console.log(status.ready ? "微信支付配置检查通过；请继续验证真实下单和公网回调。" : `微信支付配置待完成：${status.missing.join("、")}`);
  process.exitCode = status.ready ? 0 : 1;
} catch {
  console.error("微信支付配置读取失败，请检查 PEM 文件路径和权限。");
  process.exitCode = 1;
}
