# 机枪纯女电竞入职文考

Node.js 原生 HTTP 网站，无第三方 npm 依赖。默认题库来自 `content/机枪纯女文考.xlsx` 的“题目”和“考试配置”工作表。

## 考试规则

- 30 题，共 100 分：判断题 8 道，每题 3 分；单选题 20 道，每题 3 分；多选题 2 道，每题 8 分。
- 答题时长 18 分钟，85 分及以上通过。
- 每人最多 6 次机会，取已提交并经复核的最高成绩；低分复考不会覆盖较高成绩及其有效证明。
- 多选全对才得分，多选、少选、错选均不得分。
- 全部为客观题，系统自动计分；管理员可查看答卷和复核成绩。
- 每位考生按个人次数收费：首次免费，第二次 20 元，第三至六次各 30 元，考费全部归考官。

## 本地运行

需要 Node.js 20 或更高版本。在本仓库的 `exam` 目录运行：

```bash
node server.js
```

首次启动自动把随项目保存的 `content/question-bank.json` 复制到 `data/question-bank.json`，无需安装依赖或重新导入。

- 考生端：<http://localhost:3000/>
- 后台：<http://localhost:3000/admin>
- 证明查询：<http://localhost:3000/certificate>
- 首次管理员账号：`admin`，默认密码：`admin123`。

正式环境首次启动应设置 `ADMIN_PASSWORD`，并使用 HTTPS。默认所有者账号创建后保存在 `data/admin-users.json`，之后更换密码需在后台操作。

Windows PowerShell 本地预览：

```powershell
$env:HOST = '127.0.0.1'
node server.js
```

## 更新 Excel 题库

Python 3 标准库即可读取 Excel，无需安装 openpyxl：

```bash
python scripts/import-excel-bank.py 'content/机枪纯女文考.xlsx' content/question-bank.json
```

导入器校验题目、答案、题型数量、总分和考试配置。Excel、生成的题库及配置都保存在本仓库中，题库只由服务器读取，不作为公开静态文件提供。

已启动过的实例会保留 `data/question-bank.json` 和后台保存的 `data/config.json`。更换题库时先备份 `data/`，再把新的 `content/question-bank.json` 复制到 `data/question-bank.json`；在后台同步检查组卷配置、俱乐部名称和答题时长后重启。现有考试保留开始时的题目与截止时间。

## 后台功能

- 所有者、系统管理员、考官、财务的独立账号和操作权限。
- 题库维护、启停、分类筛选与组卷配置。
- 报名次数、考试答卷、成绩复核、最高分和通过证明。
- 答题码支持有效期、使用次数及可选收款统计。
- 微信 Native 订单二维码，自动核对到账、金额、商户和币种后解锁考试。
- 付款申请 30 分钟自动取消，收款、通过率和最近 7 天趋势统计。

支付配置参考 `.env.example`。必须配置商户号、绑定 AppID、APIv3 密钥、商户证书序列号及私钥、微信支付公钥 ID 与公钥、公开 HTTPS 域名。配置不完整时付费页面不展示付款码，不回退到旧收款图片；首次免费和答题码正常使用。

付款后通过验签、解密的到账通知确认，状态刷新会补充查单；重复通知不会重复计费，创建订单后不能人工确认。下单超时会查询原订单，复用相同商户订单号。密钥只存环境文件，PEM 可用文件路径或 BASE64 配置，禁止提交 Git。

部署 Node.js 20.6+ 可使用 `node --env-file=.env server.js`；Linux systemd 使用 EnvironmentFile。运行 `node --env-file=.env scripts/check-wechat-config.mjs` 可检查配置，不输出密钥。

## 数据与部署

`data/` 中的题库、管理员账号、收款、考试和成绩属于运行数据，不纳入 Git。修改后台题库后请单独备份。正式部署参考 [DEPLOYMENT.md](DEPLOYMENT.md) 和 [deploy/README.md](deploy/README.md)。

本项目在 `Chris-topher-jpg/JQCN` 中独立维护。

## 验证

```bash
npm test
node scripts/smoke-concurrency.mjs 20
```

并发检查使用隔离的临时数据，不改变本地或生产考试记录。仅本地测试需要自动确认付费时，可设置 `DEMO_AUTO_PAY=1`。
