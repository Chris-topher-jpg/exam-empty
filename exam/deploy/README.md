# 文考部署（ECS + OSS + ESA）

## 当前资源与接入状态

- ECS：`47.114.55.204`，杭州，Alibaba Cloud Linux 4，2 核 4 GiB。
- SSH：本次实例的 `bibiniao-exam-key` 绑定 `root`；`ringo` 账号尚不存在。私钥不放入项目。
- 域名：`exam.bibiniao.com`。2026-09-22 阿里云 ESA 检测 `bibiniao.com` 未备案；用户选择保留杭州、备案后正式上线。
- OSS：`bibiniao-exam-1078460870902522`，杭州，私有、阻止公共访问、AES256 托管加密。
- ESA：该域名尚未接入，未购买新套餐，未修改现有网站或 DNS。
- 当前服务器端仅提供 SSH 隧道预览。OSS 文件上传完成不代表用户流量已经经过 OSS / ESA。

2026-09-22 部署验证：本地与 ECS 均通过 48 项测试；330 道题已导入。ECS 隔离检查中 20 人开考和交卷全部成功，付费复考通过，集中交卷 P95 约 86 ms（本机回环、空历史库、无外部 AI，不能据此推算公网峰值容量）。真实服务所有者登录通过，匿名后台接口返回 401，生产考试与收款记录为空。13 个静态资源已上传 `static/`，OSS 控制台显示全部成功。备份定时器已启用，并已生成校验过的首份备份。

## 服务器目录

| 位置 | 内容 |
| --- | --- |
| `/opt/bibiniao-exam/releases/<Git SHA>` | 不可变的源代码发布版本 |
| `/opt/bibiniao-exam/current` | 当前版本软链接 |
| `/var/lib/bibiniao-exam` | 题库、付款、考试、成绩、管理员数据 |
| `/etc/bibiniao-exam.env` | 运行配置和随机生成的初始管理员密码，权限 600 |
| `/var/backups/bibiniao-exam` | 每日业务数据备份，权限 700 |

生产数据从空库开始，仅导入当前题库；本地测试付款、成绩与演示管理员不迁移。站点运行账号为无登录权限的 `bibiniao-exam`。初始后台账号是 `admin`，密码由部署脚本在服务器随机生成，需通过 SSH 私下读取环境文件交接。环境文件不得提交 Git 或上传公共目录。

## 发布与验证

1. 安装系统 Node.js 22、Nginx、OpenSSL、tar。运行 `node --test`、`git diff --check`。
2. 提交工作分支、推送、合并并推送 `main`；再次 fetch 确认发布的是最新提交。
3. 使用 `git archive --format=tar.gz HEAD` 导出代码，验证本地与服务器 SHA256。
4. 解压到 `/opt/bibiniao-exam/releases/<完整 Git SHA>`。首次单独上传 `data/question-bank.json`，禁止打包本地测试状态和管理员文件。
5. 执行 `bash deploy/install-release.sh <完整 Git SHA> <首次题库路径>`。脚本保留已有业务数据、密码及生产 Nginx 配置。
6. 检查 `systemctl status bibiniao-exam nginx` 和 `curl http://127.0.0.1:8080/api/health` 返回的 revision。
7. 在服务器运行 `ONBOARDING_EXAM_QUESTION_BANK_PATH=/var/lib/bibiniao-exam/question-bank.json node scripts/smoke-concurrency.mjs 20`，验证隔离临时库里的集中开考、交卷和付费复考流程。

上述并发检查不调用外部 AI、不改变真实考试数据，也不代表长时间容量压测或公网性能。DeepSeek 未配置时使用本地评分要点算法；上线前应补齐所需 AI 配置并验证真实接口。

备案前预览：使用已有 SSH 私钥运行 `ssh -i <私钥路径> -N -L 3300:127.0.0.1:8080 root@47.114.55.204`，访问 `http://localhost:3300/` 和 `/admin`。关闭 SSH 会断开预览。

## OSS 与备案后的 ESA 配置

仅将 `public/` 中的 CSS、JavaScript、图标和收款码上传到桶的 `static/` 前缀，保留文件名。HTML 页面和 `/api/*` 由 ECS 提供。题库（含答案）、考试状态、管理员文件均不能放入静态前缀。

备案完成后，使用 ESA 的 CNAME 接入 `bibiniao.com`，仅接入 `exam` 子域名。先确认并购买该站点所需套餐；原有 `yeshuyu.com` 套餐不移动。配置：

| 请求 | 源站 | 缓存 |
| --- | --- | --- |
| `/api/*`、HTML 页面、管理页面 | ECS Nginx，HTTPS 回源 | 不缓存，保留授权头和查询参数 |
| CSS、JS、MJS、PNG、JPG、JPEG、SVG、ICO | 私有 OSS `static/<原文件名>` | 缓存公开静态文件，保留版本查询参数 |

为 OSS 配置 ESA 私有回源授权，仅允许读取 `static/*`；桶保持私有。源站规则需同时设置 OSS Host、HTTPS 和路径前缀，避免通过 Nginx 代理 OSS 文件。若所选套餐不支持所需路径回源规则，先调整接入设计再启用流量。

配置 `exam.bibiniao.com` 的有效 TLS 证书、HTTPS 重定向及源站证书后，将 DNS 的 `exam` 记录指向 ESA 提供的 CNAME。更新静态文件后刷新对应 ESA 缓存。启用前验证：公共 HTTPS、匿名管理接口返回 401、登录/付款/交卷不缓存、两张收款码正常、静态响应确实来自 OSS 且 ESA 第二次请求缓存命中。

静态文件经 OSS + ESA 提供后不占用 ECS 的静态下载带宽；考试 API 与页面回源仍会使用服务器带宽。OSS 存储/请求/回源和 ESA 套餐各有费用。

## 备份及回滚

`bibiniao-exam-backup.timer` 每天备份业务数据；检查备份文件与 SHA256，并定期安全导出到站外。当前并未配置 OSS 自动备份权限。保留已有发布版本，回滚时切换 `current` 后重启服务，业务数据保持原位。新增数据结构时先验证备份与恢复兼容性。
