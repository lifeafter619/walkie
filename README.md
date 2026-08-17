<div align="center">

# 📻 Walkie

**AI Agent 与你之间的双向对讲机**

Agent 干完活呼叫你、拿不准主意时问你，你在任何设备上按下回复——一条 MCP 连接搞定。

[![License](https://img.shields.io/badge/license-MIT-22c55e)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.3.0-black)](package.json)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-6366f1)](https://modelcontextprotocol.io)

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare%20Workers-F38020?logo=cloudflareworkers&logoColor=white)](#一cloudflare-workers推荐)
[![Vercel](https://img.shields.io/badge/Vercel-000000?logo=vercel&logoColor=white)](#二vercel--turso)
[![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)](#三docker--docker-compose)
[![Self-hosted](https://img.shields.io/badge/私有部署-Node.js-475569)](#四企业--私有网络部署)

</div>

---

AI Agent 跑长任务时，你不想盯着终端。Walkie 是一个自托管的通知控制平面：

- **Agent → 你**：构建完成、部署失败、审批请求，推送到 Telegram、WhatsApp、企业微信、飞书、Expo、OneSignal、邮件、短信……75+ 渠道任选；
- **你 → Agent**：Agent 调用 `ask_user` 把问题推到你手机，你点开一次性链接（或直接在控制台）回复，Agent 拿到答案继续干活；
- **一个入口**：MCP（Streamable HTTP）、REST API、Server酱兼容 URL 三种接入方式，凭据加密存储，全部跑在你自己的基础设施上。

## 核心特性

- 📡 **75+ 通知渠道**——聊天（Telegram / WhatsApp / 企业微信应用 / 飞书 / 钉钉 / Slack / Discord / Teams / Google Chat / KOOK / QQ 官方机器人 / Matrix / LINE…）、推送（FCM / Expo / OneSignal / Huawei / HONOR / Xiaomi / OPPO / vivo / 魅族 / JPush / 个推 / Join / Pushy / Pushsafer / Simplepush / Pusher Beams / Pushpad / Bark / ntfy / Gotify / Pushover / Server酱 / PushPlus / WxPusher…）、编排（Novu / Knock / Courier）、自动化（IFTTT Webhooks）、邮件（SMTP / SendGrid / Resend / Postmark / Mailgun / Brevo）、短信（Twilio / 阿里云 / 腾讯云 / AWS SNS / Vonage / Plivo / Telnyx / Bird / Infobip）、PagerDuty、Jira Service Management、Alertmanager、Apprise、通用 Webhook。新增渠道的官方契约和验证边界见 [`docs/providers.md`](docs/providers.md)。
- 🔁 **双向会话**——`ask_user` 提问 + 一次性回复链接 + 控制台会话页直接回复，`check_reply` 长轮询取答案
- 🧭 **路由**——多个频道组成「并发广播」或「故障转移链」，一个稳定标识符对外
- 🔑 **密钥即密码**——Agent Key 和管理密码都可以自定义成任意想要的值（≥8 位），也可一键随机生成
- 🪝 **投递回调**——`callbackUrl` 在投递到达终态时回推结果
- ⏱️ **限流与静默时段**——按频道每分钟限流；`22:00-08:00@Asia/Shanghai` 静默期延后发送，critical 穿透
- 🔒 **安全默认**——凭据 AES-256-GCM 加密（KEK/DEK 两级密钥，可在线轮换）、密钥哈希存储、SSRF 防护（默认禁私网/HTTP）、scope 与目的地白名单
- 📱 **控制台**——响应式管理面板，暗色模式，移动端可用

## 快速开始

四种部署方式，选一种即可。部署完成后打开站点，用管理密码登录，添加频道 → 创建 Agent Key → 在「接入」页复制 MCP 配置。

### 一、Cloudflare Workers（推荐）

免费额度足够个人使用；数据存 Durable Objects SQLite，无需外部数据库。

```bash
git clone https://github.com/<你的用户名>/walkie.git && cd walkie
npm ci
npx wrangler login

# 生成 32 字节根密钥（Windows 无 openssl 时：
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"）
openssl rand -base64 32 | npx wrangler secret put MASTER_KEY

# 设置管理密码（≥8 位，登录控制台用；之后可在面板里随时改）
npx wrangler secret put ADMIN_TOKEN

npm run deploy:cf
```

部署完成后访问 `https://walkie.<你的子域>.workers.dev`。

> 推送到 GitHub 后，可以给仓库加一键部署按钮：
> `https://deploy.workers.cloudflare.com/?url=https://github.com/<你的用户名>/walkie`

### 二、Vercel + Turso

Serverless 部署，状态存 [Turso](https://turso.tech)（libSQL），队列由请求内投递 + Vercel Cron 兜底重试。

1. 创建 Turso 数据库，拿到 `TURSO_DATABASE_URL` 与 `TURSO_AUTH_TOKEN`；
2. 导入本仓库到 Vercel（`vercel.json` 已带构建与 Cron 配置）；
3. 配置环境变量：

| 变量 | 说明 |
| --- | --- |
| `TURSO_DATABASE_URL` | `libsql://…` 数据库地址 |
| `TURSO_AUTH_TOKEN` | Turso 访问令牌 |
| `ADMIN_TOKEN` | 管理密码（≥8 位） |
| `MASTER_KEY` | base64 的 32 字节根密钥 |
| `CRON_SECRET` | 保护 `/api/cron/drain` 的随机串（Vercel 自动注入到 Cron 请求头） |
| `PUBLIC_URL` | 站点最终地址，如 `https://walkie.example.com`（用于回复链接） |

4. 部署。Cron 每 10 分钟兜底排空一次重试队列（`vercel.json` 可调）。

> 一键部署链接：`https://vercel.com/new/clone?repository-url=https://github.com/<你的用户名>/walkie`

### 三、Docker / Docker Compose

单容器 + 本地 SQLite 卷，适合 NAS 与家庭服务器。

```bash
ADMIN_TOKEN='你的管理密码' \
MASTER_KEY="$(openssl rand -base64 32)" \
docker compose up -d --build
```

- 默认只绑定 `127.0.0.1:4310`，用 Nginx/Caddy 反代并终结 TLS 后再对外；
- 数据在 `relaydock-data` 卷（新安装使用 `/app/data/walkie.db`，旧安装自动继续使用 `relaydock.db`），**备份时连同 `MASTER_KEY` 一起保存**，两者缺一不可恢复。

Caddy 反代两行即可：

```
walkie.example.com {
    reverse_proxy 127.0.0.1:4310
}
```

### 四、企业 / 私有网络部署

裸机 Node.js，适合需要触达内网服务（自建 Gotify、OneBot QQ 机器人、内网 Webhook）的场景。

```bash
# Node.js ≥ 22
git clone https://github.com/<你的用户名>/walkie.git && cd walkie
npm ci && npm run build

NODE_ENV=production \
HOST=0.0.0.0 PORT=4310 \
ADMIN_TOKEN='你的管理密码' \
MASTER_KEY="$(openssl rand -base64 32)" \
ALLOW_PRIVATE_WEBHOOKS=true \
node dist/server/index.js
```

systemd 单元示例：

```ini
[Unit]
Description=Walkie notification control plane
After=network-online.target

[Service]
User=walkie
WorkingDirectory=/opt/walkie
EnvironmentFile=/opt/walkie/.env
ExecStart=/usr/bin/node dist/server/index.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

内网注意事项：

- `ALLOW_PRIVATE_WEBHOOKS=true` 允许通知发往私网地址（OneBot、内网 Apprise 等必需）；
- 目标服务只有 HTTP 时再加 `ALLOW_INSECURE_HTTP=true`；
- 对外暴露前务必经反向代理加 TLS，并保持 `ADMIN_TOKEN` 已设置——绑定非回环地址且未设管理密码时进程会拒绝启动。

## 接入你的 Agent

在控制台「密钥」页创建 Agent Key（可自定义成好记的密码，或用随机生成的 `rdk_` 密钥），然后任选一种方式：

### MCP（推荐）

`https://你的域名/mcp`，Streamable HTTP + Bearer 鉴权。控制台「接入」页可直接复制以下配置：

```jsonc
// Claude Code — .mcp.json
{
  "mcpServers": {
    "walkie": {
      "type": "http",
      "url": "https://你的域名/mcp",
      "headers": { "Authorization": "Bearer ${WALKIE_API_KEY}" }
    }
  }
}
```

```toml
# Codex — ~/.codex/config.toml
[mcp_servers.walkie]
url = "https://你的域名/mcp"
bearer_token_env_var = "WALKIE_API_KEY"
```

| MCP 工具 | 作用 |
| --- | --- |
| `list_destinations` | 列出该 Key 可用的频道与路由 |
| `send_notification` | 发送通知，返回 deliveryId |
| `get_delivery` | 查询投递的总体与分频道状态 |
| `ask_user` | 向人类提问，推送一次性回复链接 |
| `check_reply` | 长轮询等待人类回复 |
| `list_routes` | 列出可用路由 |
| `list_channel_types` / `list_channels` | 渠道类型字段定义 / 渠道列表（`config:write`） |
| `create_channel` / `update_channel` / `delete_channel` | 渠道管理（`config:write`） |
| `test_channel` | 发送测试消息验证渠道连通性（`config:write`） |
| `create_route` / `update_route` / `delete_route` | 路由管理（`config:write`） |

给 Key 开启「配置管理」（`config:write`）权限后，可以直接对 Agent 说人话完成配置：

> 「帮我配一个 Telegram，Bot Token 是 123:abc，Chat ID 是 42，配好测一下」

Agent 会调用 `list_channel_types` 查字段 → `create_channel` 建渠道 → `test_channel` 验证连通 → 回报结果。所有变更写审计表（区分管理员与 Agent 操作）；配置工具不含任何 Key 管理能力，Agent 无法给自己提权。

### REST API

```bash
curl -X POST https://你的域名/api/v1/notify \
  -H "Authorization: Bearer <AgentKey>" \
  -H "content-type: application/json" \
  -d '{"destination":"prod-alerts","title":"部署完成","body":"v2.4.0 已上线","severity":"success"}'
```

`POST /api/v1/ask` 提问、`GET /api/v1/conversations/:id` 取回复、`GET /api/v1/deliveries/:id` 查投递。

### Server酱兼容

任何支持 Server酱的现有工具可以零改造切过来，把推送地址换成：

```
https://你的域名/send/<AgentKey>.send
```

支持 `title` / `desp` / `tags` / `short` 参数；Key 配置了多个目的地时用 `destination` 参数指定。

## 双向确认是怎么工作的

```
Agent ── ask_user("要不要回滚？", 选项) ──► Walkie
Walkie ── 推送问题 + 一次性链接 ──► 你的手机（任意已配置渠道）
你     ── 点选项或输入回复（或直接在控制台「会话」页回） ──► Walkie
Agent  ── check_reply 长轮询 ──► 拿到答案，继续执行
```

链接一次有效、到期作废（30 秒 ~ 24 小时可调），无需给回复者任何账号。

## 环境变量参考

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `ADMIN_TOKEN` | — | 管理密码（≥8 位）。生产必填；之后可在面板改，env 值与面板密码并存 |
| `MASTER_KEY` | — | base64 的 32 字节根密钥(KEK)，加密所有渠道凭据。生产必填，**丢失即无法解密数据** |
| `PORT` / `HOST` | `4310` / `127.0.0.1` | 监听地址（Node 部署） |
| `DATA_DIR` | `./data` | SQLite 数据目录（Node 部署） |
| `ALLOW_PRIVATE_WEBHOOKS` | `false` | 允许通知发往私网/回环地址 |
| `ALLOW_INSECURE_HTTP` | `false` | 允许 HTTP 通知地址 |
| `DELIVERY_WORKERS` | `2` | 每轮并发投递数 |
| `MAX_SENDS_PER_MIN` | `0` | 全局每分钟发送上限，0 不限 |
| `MAX_DELIVERY_ATTEMPTS` | `4` | 单渠道最大尝试次数（指数退避）；频道可单独设「重试上限」覆盖 |
| `RETRY_BASE_MS` | `2000` | 重试退避基数 |
| `PUBLIC_URL` | — | 站点对外地址（回复链接、MCP 配置展示用） |
| `UPDATE_REPO` | `lifeafter619/walkie` | 应用内版本检查指向的 GitHub 仓库（owner/name，自建 fork 时改这里） |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | — | 使用 Turso/libSQL 远程数据库（Vercel 部署） |
| `CRON_SECRET` | — | Vercel Cron 鉴权 |

## 安全模型

- 渠道凭据 AES-256-GCM 加密落盘；两级密钥（env `MASTER_KEY` 为 KEK，数据密钥 DEK 可在控制台在线轮换并原子重加密）；
- Agent Key 与管理密码只存 sha256 哈希做鉴权；Agent Key 另存一份加密副本供面板查看复制；
- 出站通知默认拒绝私网/回环/保留地址与明文 HTTP（SSRF 防护），重定向一律拒绝；
- 每个 Agent Key 可限定 scope（发送/读取/配置管理）与目的地白名单（如 5 个渠道开 5 个 Key 各管一个），可随时编辑范围，一键吊销；
- 回复链接带一次性 token，回复后立即失效；所有敏感操作写审计表，「审计」页可按操作者与动作类型检索；
- 「系统」页可配置数据保留策略（投递/会话/审计各自保留天数，0 为永久），每日自动清理过期数据，也可手动触发。

## 常见问题

**忘记管理密码？** 设置一个新的 env 密码即可：Cloudflare 用 `wrangler secret put ADMIN_TOKEN`；Docker/Node 改环境变量后重启。登录后可在面板再改。注意：面板轮换过的密码保存在数据库中，重设 env 后旧的面板密码仍有效，需登录面板重新轮换覆盖。

**换设备后 Agent Key 丢了？** 「密钥」页可直接查看并复制（明文加密存储）；也可以吊销后重建。

**Cloudflare 上 SMTP 能用吗？** Workers 的 `nodejs_compat` 提供 TCP socket 支持，多数 465/587 SMTP 服务可用；不可用时建议改用 HTTP 类渠道或在 Node/Docker 部署里发信。

**通知没到？** 「投递」页看每个渠道的尝试记录与错误信息；「频道」页有一键测试。

## 开发

```bash
npm ci
npm run dev        # API（Node, 端口 4310）
npm run dev:web    # 控制台（Vite）
npm test           # vitest
npm run typecheck
```

架构：`src/server`（Express + 队列 + 渠道调度，Node/Vercel/Workers 共用核心）、`src/worker`（Cloudflare Durable Object 入口）、`src/web`（React 控制台）、`api/`（Vercel 入口）。添加新渠道见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## License

[MIT](LICENSE)
