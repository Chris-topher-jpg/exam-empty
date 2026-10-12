# 机枪纯女电竞部署说明

## 运行要求

Node.js 20+。没有第三方 npm 依赖，直接在 exam 目录运行 `node server.js`。Python 3 仅用于重新生成 Excel 题库，导入脚本只使用标准库。

首次启动自动从 `content/question-bank.json` 初始化运行题库。默认配置来自表格：30 题（判断 8、单选 20、多选 2）、100 分、18 分钟、85 分通过、6 次机会取最高分。

## 环境变量

参考 `.env.example`，通过进程环境或 systemd 的 EnvironmentFile 加载；程序不自动读取 .env。

- `HOST=127.0.0.1`：由反向代理访问。
- `PORT=3000`：模板的应用内网端口，Nginx 预览入口为 8080。实际独立服务可配置其他未占用的端口。
- `ADMIN_PASSWORD`：首次创建所有者的强密码。
- `RELEASE_REVISION`：当前 Git 提交号，可通过 `/api/health` 检查。
- `ONBOARDING_EXAM_PUBLIC_URL`：你实际配置的公开域名。
- `ONBOARDING_EXAM_STATE_PATH`、`ONBOARDING_EXAM_CONFIG_PATH`、`ONBOARDING_EXAM_ADMIN_USERS_PATH`、`ONBOARDING_EXAM_QUESTION_BANK_PATH`：持久化业务数据位置。

`DEMO_AUTO_PAY=1` 仅用于本地演示；正式环境关闭。微信收款需配置 `.env.example` 的全部微信变量和公网 HTTPS 回调地址。详见 [README.md](README.md) 的微信支付说明。

## 数据初始化与更新

初次独立部署时，复制 `content/question-bank.json` 到持久化题库位置。题库包含答案，不得部署为公开静态文件。

更新表格后运行：

```bash
python scripts/import-excel-bank.py 'content/机枪纯女文考.xlsx' content/question-bank.json
```

已存在运行题库时，程序保留该题库及后台编辑。先备份题库和配置，再复制新题库，并在后台核对组卷规则、名称和时长。已经开始的考试保留当时的题目副本。

## Linux 服务

示例路径、systemd 服务、备份脚本见 [deploy/README.md](deploy/README.md)。将 Nginx 示例中的 `exam.example.com` 换成自己的域名，配置有效 TLS 证书并使用 HTTPS。

正式数据与管理员文件放在持久化目录中，权限 600，按日备份并定期验证恢复。只公开 public 目录中的静态文件和应用路由，禁止公开 data、content 或环境文件。

## 发布验证

运行 `npm test`，验证 `/api/health` 的 revision、考生端名称与规则、后台题库数量、登录、计分、最高分和证明查询。并发检查可运行 `ONBOARDING_EXAM_QUESTION_BANK_PATH=/var/lib/jqcn-exam/question-bank.json node scripts/smoke-concurrency.mjs 20`。
