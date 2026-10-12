# 机枪纯女电竞独立部署模板

以下为新项目的部署模板，需配置自己的服务器、域名和 SSH 密钥。

| 路径 | 用途 |
| --- | --- |
| /opt/jqcn-exam/releases/<Git SHA> | 源代码发布版本 |
| /opt/jqcn-exam/current | 当前版本软链接 |
| /var/lib/jqcn-exam | 题库、付款、考试、成绩、管理员数据 |
| /etc/jqcn-exam.env | 运行配置与首次管理员密码 |
| /var/backups/jqcn-exam | 每日数据备份 |

服务运行账号为无登录权限的 jqcn-exam。首次安装时传入 content/question-bank.json；安装脚本不会覆盖已有运行题库或环境配置。

```bash
sudo bash deploy/install-release.sh /opt/jqcn-exam/releases/<完整Git提交号> content/question-bank.json
```

部署之前修改 nginx-preview.conf 的域名和 install-release.sh 的公开地址，配置 HTTPS。示例服务为 jqcn-exam.service，备份为 jqcn-exam-backup.service / jqcn-exam-backup.timer。首次管理员密码由安装脚本生成，通过服务器环境文件交接。

Windows SSH 预览：

```text
preview-server.cmd 你的SSH私钥路径 用户名@你的服务器
```

本地入口为 http://localhost:3300/，转发到服务器 127.0.0.1:8080。日常开发可直接在 exam 目录运行 node server.js，无需 SSH。

发布后检查健康接口与 Git revision，检查题库 30 题、总分 100、18 分钟、85 分通过、6 次取最高分。每日备份保存业务数据，回滚时切换 current 并重启服务，业务数据保留原位。
