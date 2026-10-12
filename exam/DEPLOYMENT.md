# 部署与交接手册

本项目 ECS / OSS / ESA 的资源、备案等待状态、SSH 预览与发布步骤见 [deploy/README.md](deploy/README.md)。

## 1. 运行要求

- Node.js 20 或更高版本
- Python 3（只有重新导入 Word 题库时需要）
- 一个可访问的服务器端口，默认 `3000`

项目没有第三方 npm 依赖，下载后可以直接启动。

## 2. 快速启动

macOS / Linux：

```bash
cd jlb-entry-exam
ADMIN_PASSWORD='设置一个强密码' node server.js
```

Windows PowerShell：

```powershell
cd jlb-entry-exam
$env:ADMIN_PASSWORD = '设置一个强密码'
node server.js
```

页面入口：

```text
http://服务器IP:3000/
http://服务器IP:3000/admin
http://服务器IP:3000/certificate
```

管理员后台不会出现在考生端或证明查询页的公开导航中，请通过 `/admin` 地址直接访问。

## 3. 管理员交接信息

首次启动时，系统会创建一个所有者账号：

```text
用户名：admin
初始密码：admin123
正式初始密码：由部署人员通过 ADMIN_PASSWORD 设置
```

建议交接时立即执行：

```bash
ADMIN_PASSWORD='新的强密码' node server.js
```

首次启动后，账号将保存为带随机盐的 scrypt 哈希，不保存明文密码。后续可由所有者在“管理员账号”页面创建多个独立账号、设置角色、停用账号或重置密码。`ADMIN_PASSWORD` 不会覆盖已经创建的账号。

角色包括所有者、系统管理员、考官和财务。考官仅查看及复核成绩，财务仅查看及确认付款。

DeepSeek 主观题评分建议使用独立权限为 600 的环境文件：

```text
DEEPSEEK_API_KEY=你的密钥
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_TIMEOUT_MS=20000
```

systemd 服务通过 `EnvironmentFile` 加载该文件。不要把密钥放进项目目录、部署包或 Git。AI 不可用时会自动使用本地评分算法兜底。

答题码保存在 `data/state.json`，包括生成者、有效期、使用次数、使用者和关联考试资格。备份业务状态时会一并备份。

## 4. 配置收款码

1. 将微信收款码替换为 `public/payment-wechat.jpg`，将支付宝收款码替换为 `public/payment-alipay.jpg`。
2. 重启服务或重新部署静态文件。
3. 打开考生付款页，确认微信和支付宝两张收款码均可正常显示。
4. 用手机扫描对应收款码做一笔小额测试。
5. 登录收款平台确认到账，再在后台确认付款。

当前系统默认是人工确认模式。静态商户码不向本网站发送到账通知，因此不能仅凭上传二维码实现自动回调。

## 5. 演示测试

本地测试时可以开启：

```bash
DEMO_AUTO_PAY=1 ADMIN_PASSWORD='admin123' node server.js
```

演示模式会自动确认新建和旧的待付款申请。正式环境严禁开启此变量。

## 6. 生产运行建议

```bash
npm install -g pm2
ADMIN_PASSWORD='强密码' pm2 start server.js --name jlb-exam
pm2 save
pm2 startup
```

Nginx 反向代理示例：

```nginx
server {
    listen 443 ssl http2;
    server_name exam.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

请为域名配置 HTTPS 证书，不要直接把 Node 端口裸露在公网。

## 7. 数据备份

需要备份的内容：

- `data/state.json`：付款、考试、成绩、通过证明
- `data/config.json`：站点设置
- `data/admin-users.json`：管理员账号和密码哈希
- `public/payment-wechat.jpg`、`public/payment-alipay.jpg`：考试付款页使用的微信和支付宝收款码
- `data/question-bank.json`：已导入的题库，包含评分答案，不纳入 Git，必须单独安全备份

题库也可以在后台“题库管理”中维护。修改只影响之后生成的新试卷，已经开始的试卷会保留当时的题目副本。

建议每天备份 `data/`，并把备份放在服务器之外。

## 8. 重置测试数据

停止服务后执行：

```bash
rm -f data/state.json
```

再次启动后会自动生成空数据。正式环境执行前必须先备份。

## 9. 更新题库

```bash
python3 scripts/import-word-bank.py '比比鸟电竞文考题库.docx' data/question-bank.json
node --test
```

测试通过后重启服务。
