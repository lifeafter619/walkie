<div align="center">

# 📻 Walkie

**AI Agent 与你之间的双向对讲机**

Agent 干完活呼叫你、拿不准主意时问你，你在任何设备上按下回复——一条 MCP 连接搞定。

[![License](https://img.shields.io/badge/license-MIT-22c55e)](LICENSE)
[![CI](https://github.com/lifeafter619/walkie/actions/workflows/ci.yml/badge.svg)](https://github.com/lifeafter619/walkie/actions/workflows/ci.yml)
[![Version](https://img.shields.io/badge/version-0.3.0-black)](package.json)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-6366f1)](https://modelcontextprotocol.io)

[English](README.md) · [简体中文](README.zh-CN.md)

**一键部署**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lifeafter619/walkie)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Flifeafter619%2Fwalkie&env=TURSO_DATABASE_URL,TURSO_AUTH_TOKEN,ADMIN_TOKEN,MASTER_KEY,CRON_SECRET&envDescription=Turso%20%E6%95%B0%E6%8D%AE%E5%BA%93%E3%80%81%E7%AE%A1%E7%90%86%E5%AF%86%E7%A0%81%E4%B8%8E%2032%20%E5%AD%97%E8%8A%82%E6%A0%B9%E5%AF%86%E9%92%A5&envLink=https%3A%2F%2Fgithub.com%2Flifeafter619%2Fwalkie%23%E4%BA%8Cvercel--turso&project-name=walkie&repository-name=walkie)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/lifeafter619/walkie)

</div>

---

AI Agent 跑长任务时，你不想盯着终端。Walkie 是一个自托管的通知控制平面：

- **Agent → 你**：构建完成、部署失败、审批请求，推送到 Telegram、WhatsApp、企业微信、飞书、Expo、OneSignal、邮件、短信……75+ 渠道任选；
- **你 → Agent**：Agent 调用 `ask_user` 把问题推到你手机，你点按钮、回一句话或点开一次性链接，Agent 拿到答案继续干活；跑到一半想改方向，也可以主动发消息进它的收件箱；
- **一个实例，多种入口**：MCP、REST、Server酱、Bark、Gotify、PushPlus、ntfy 兼容端点共用同一套频道与 Agent Key。

## 核心特性

- 📡 **75+ 通知渠道**——聊天（Telegram / WhatsApp / 企业微信应用 / 飞书 / 钉钉 / Slack / Discord / Teams / Google Chat / KOOK / QQ 官方机器人 / Matrix / LINE…）、推送（FCM / Expo / OneSignal / Huawei / HONOR / Xiaomi / OPPO / vivo / 魅族 / JPush / 个推 / Join / Pushy / Pushsafer / Simplepush / Pusher Beams / Pushpad / Bark / ntfy / Gotify / Pushover / Server酱 / PushPlus / WxPusher…）、编排（Novu / Knock / Courier）、自动化（IFTTT Webhooks）、邮件（SMTP / SendGrid / Resend / Postmark / Mailgun / Brevo）、短信（Twilio / 阿里云 / 腾讯云 / AWS SNS / Vonage / Plivo / Telnyx / Bird / Infobip）、PagerDuty、Jira Service Management、Alertmanager、Apprise、通用 Webhook。新增渠道的官方契约和验证边界见 [`docs/providers.md`](docs/providers.md)。
- 🔁 **双向会话**——`ask_user` 提问 + 一次性回复链接，Telegram / Slack / Discord 按钮点按即回，Telegram 与 Slack 还能直接回一句话；`check_reply` 长轮询取答案
- 📥 **你也能主动找 Agent**——`wait_for_inbox` 让你在控制台或直接给机器人发消息，中途改变正在跑的 Agent 的方向，不用等它来问
- 🖥️ **内置 Web Push**——控制台一键订阅本浏览器（VAPID + RFC 8291），不用上架 App，也不用第三方账号
- 🧭 **路由**——多个频道组成「并发广播」或「故障转移链」，一个稳定标识符对外
- 🔑 **密钥即密码**——Agent Key 和管理密码都可自定义；多条管理密码可并存、统计和单独撤销
- 🪝 **投递回调**——`callbackUrl` 在投递到达终态时回推结果
- ⏱️ **限流与静默时段**——按频道每分钟限流；`22:00-08:00@Asia/Shanghai` 静默期延后发送，critical 穿透
- 🔒 **安全默认**——凭据 AES-256-GCM 加密（KEK/DEK 两级密钥，可在线轮换）、密钥哈希存储、SSRF 防护（默认禁私网/HTTP）、scope 与目的地白名单
- 📱 **控制台**——响应式管理面板，暗色模式，移动端可用

## 快速开始

五种部署方式，选一种即可。部署完成后打开站点，用管理密码登录，添加频道 → 创建 Agent Key → 在「接入」页复制 MCP 配置。

| 平台 | 一键部署 | 状态存储 | 说明 |
| --- | --- | --- | --- |
| Cloudflare Workers | [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lifeafter619/walkie) | Durable Objects SQLite | 免费额度充足，无需外部数据库。部署后需补两条 secret |
| Vercel | [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Flifeafter619%2Fwalkie&env=TURSO_DATABASE_URL,TURSO_AUTH_TOKEN,ADMIN_TOKEN,MASTER_KEY,CRON_SECRET&envDescription=Turso%20%E6%95%B0%E6%8D%AE%E5%BA%93%E3%80%81%E7%AE%A1%E7%90%86%E5%AF%86%E7%A0%81%E4%B8%8E%2032%20%E5%AD%97%E8%8A%82%E6%A0%B9%E5%AF%86%E9%92%A5&envLink=https%3A%2F%2Fgithub.com%2Flifeafter619%2Fwalkie%23%E4%BA%8Cvercel--turso&project-name=walkie&repository-name=walkie) | Turso / libSQL | 部署表单里直接填环境变量，需要先建好 Turso 库 |
| Render | [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/lifeafter619/walkie) | 容器持久盘 SQLite | 走 `render.yaml` + Dockerfile；持久盘需 starter 及以上套餐 |
| Docker / NAS / 裸机 | 见下方命令 | 本地 SQLite | 完全自控，可触达内网服务 |

> 一键部署创建的实例在补齐 secret 之前会显示一页设置说明，而不是 500 错误页。

### 一、Cloudflare Workers（推荐）

数据存 Durable Objects SQLite，无需外部数据库。免费额度见下方「免费额度与用量监控」。

点上面的按钮部署后，Cloudflare 会把仓库 fork 到你的账号并自动创建 Durable Object。**一键部署无法代填 secret**，站点会先显示设置说明页，按页面提示在本地补上这两条即可：

```bash
git clone https://github.com/<你的账号>/walkie.git && cd walkie
npm ci && npx wrangler login

# 生成 32 字节根密钥（Windows 无 openssl 时：
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"）
openssl rand -base64 32 | npx wrangler secret put MASTER_KEY

# 设置管理密码（≥8 位，登录控制台用；之后可在面板里随时改）
npx wrangler secret put ADMIN_TOKEN
```

想完全手动部署也可以：克隆本仓库后执行上面两条 secret 命令，再跑 `npm run deploy:cf`，站点为 `https://walkie.<你的子域>.workers.dev`。

### 二、Vercel + Turso

Serverless 部署，状态存 [Turso](https://turso.tech)（libSQL），队列由请求内投递 + Vercel Cron 兜底重试。

先创建 Turso 数据库拿到 `TURSO_DATABASE_URL` 与 `TURSO_AUTH_TOKEN`，再点上面的 Vercel 按钮——部署表单会直接要求填下面这些变量：

| 变量 | 说明 |
| --- | --- |
| `TURSO_DATABASE_URL` | `libsql://…` 数据库地址 |
| `TURSO_AUTH_TOKEN` | Turso 访问令牌 |
| `ADMIN_TOKEN` | 管理密码（≥8 位） |
| `MASTER_KEY` | base64 的 32 字节根密钥 |
| `CRON_SECRET` | 保护 `/api/cron/drain` 的随机串（Vercel 自动注入到 Cron 请求头） |
| `PUBLIC_URL` | 可选。站点最终地址，如 `https://walkie.example.com`（用于回复链接） |

Hobby 计划的 Cron 每天最多运行一次，因此默认每天 03:00 UTC 兜底排空重试队列；正常请求仍会立即触发投递。

### 三、Render

`render.yaml` 已经写好 Docker 构建、健康检查和 1 GB 持久盘，点按钮后只需填 `ADMIN_TOKEN` 与 `MASTER_KEY`。注意 Render 的免费实例不提供持久盘，蓝图默认使用 starter 套餐；换回免费套餐会在每次重新部署时丢失频道与密钥。

### 四、Docker / Docker Compose

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

### 五、企业 / 私有网络部署

裸机 Node.js，适合需要触达内网服务（自建 Gotify、OneBot QQ 机器人、内网 Webhook）的场景。

```bash
# Node.js ≥ 22
git clone https://github.com/lifeafter619/walkie.git && cd walkie
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

### 免费额度与用量监控

截至 2026-08，平台公开免费额度如下；平台可能调整，部署前以官方页面为准：

| 平台 | 免费计划主要限制 | 官方来源 |
| --- | --- | --- |
| Cloudflare Workers | 100,000 请求/天、10 ms CPU/请求、128 MB 内存；Durable Objects 100,000 请求/天；DO SQLite 读取 500 万行/天、写入 10 万行/天、5 GB | [Workers Limits](https://developers.cloudflare.com/workers/platform/limits/) / [Durable Objects Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Vercel Hobby（Fluid Compute） | 1,000,000 函数调用/月、4 CPU 小时/月、360 GB-hours 内存/月；Cron 每天最多一次且精度为 ±59 分钟 | [Hobby Plan](https://vercel.com/docs/plans/hobby) / [Limits](https://vercel.com/docs/limits) / [Cron](https://vercel.com/docs/cron-jobs/usage-and-pricing) |

「系统 → 额度与用量」同时显示 Walkie 自己的投递统计和平台 API 快照。平台 Token 使用现有 DEK 做 AES-GCM 加密，接口和浏览器只会看到“已配置”状态，不会返回明文。

- Cloudflare：填写 API Token、Account ID 和 Worker 脚本名。用量读取需要 `Account → Account Analytics → Read`；自动识别 Workers Free/Paid 还需要 `Account → Billing → Read`，不授予账单权限时可手动选择套餐。系统每 15 分钟通过 [GraphQL Analytics API](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/) 读取当天的请求、错误和子请求。
- Vercel：填写 Access Token；Team ID 和 Project ID 可选。系统读取 [Billing Charges API](https://vercel.com/docs/rest-api/billing/list-focus-billing-charges) 的当月 FOCUS JSONL 数据，按实际返回的服务与单位展示指标。管理页打开时最多每 15 分钟同步一次；Hobby 空闲部署受 Cron 限制，只能保证每日检查一次。
- 每个指标可设置绝对阈值，并选择“仅告警”“仅暂停新推送”或“告警并暂停新推送”。阈值告警按平台计费周期幂等去重；API 请求失败或快照过期不会触发暂停，暂停后可在同一页面手动恢复。

平台账单数据可能延迟，CPU、Durable Objects 行读写及 Turso 用量仍应以各平台控制台为最终依据。

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
| `ask_user` | 向人类提问，推送一次性回复链接（Telegram / Slack / Discord 渲染按钮，点按即回） |
| `check_reply` | 长轮询等待人类回复 |
| `wait_for_inbox` | 长轮询取走人类**主动**发来的消息——来自控制台或直接发给 Telegram 机器人；每条消息只会被一个 Agent 取到 |
| `report_idle` | 上报人类离开键盘秒数；idle < 120s 时非 critical 的手机推送延后，桌面照推 |
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

### 连接其他 Walkie 实例

不同平台部署的 Walkie 可以直接互相调用：远端管理员先创建一个仅允许访问指定频道或路由、具备 `notifications:send` 权限的 Agent Key；本地在「频道」中新增「Walkie 实例」，填写远端站点地址、该 Agent Key 和远端目的地 ID / slug。之后该频道可以像普通频道一样加入本地路由。

跨实例投递会自动携带本地投递 ID 作为远端幂等键，并在 `X-Walkie-Trace` 中记录已访问实例。再次进入相同实例或超过 8 跳时会终止转发，避免路由配置错误形成通知回环。多个域名指向同一实例时仍以 8 跳上限兜底。

`POST /api/v1/ask` 提问、`GET /api/v1/conversations/:id` 取回复、`GET /api/v1/deliveries/:id` 查投递。完整机器可读契约见 `GET /openapi.json`（OpenAPI 3.1）。

### stdio MCP 包装 — 本地零部署

只支持 stdio 的 MCP 客户端可通过 [`packages/walkie-mcp`](packages/walkie-mcp) 直连已部署实例：

```jsonc
// Claude Code — .mcp.json
{ "mcpServers": { "walkie": {
  "command": "npx", "args": ["-y", "walkie-mcp@latest", "--url", "https://你的域名", "--token", "rdk_..."]
} } }
```

### CLI 与 GitHub Action — `npx walkie-notify send`

```bash
npx walkie-notify send --url https://你的域名 --token rdk_... --to prod-alerts \
  --title "部署失败" --body "已执行回滚" --severity critical
```

可复用 workflow：`uses: lifeafter619/walkie/.github/workflows/notify.yml@main`，详见 [`packages/walkie-cli`](packages/walkie-cli)。

### Server酱兼容

任何支持 Server酱的现有工具可以零改造切过来，把推送地址换成：

```
https://你的域名/send/<AgentKey>.send
```

支持 `title` / `desp` / `tags` / `short` 参数；Key 配置了多个目的地时用 `destination` 参数指定。

### Bark 兼容

Walkie 提供 Bark V2 `/push`、旧式路径推送，以及 `/ping`、`/healthz`、`/info` 端点。`device_key` 使用已配置 Bark 频道的 Device Key，或使用只绑定一个目的地的 Agent Key：

```bash
curl -X POST https://你的域名/push \
  -H "content-type: application/json" \
  -d '{"device_key":"<Bark Device Key 或 Agent Key>","title":"部署完成","body":"v2.4.0 已上线","level":"active"}'
```

这是兼容 relay，不是独立 APNs Bark 后端；`/register` 只校验已有 key，不保存 Bark 设备令牌。需要完整设备注册/APNs 服务时，使用 `Finb/bark-server`、`cwxiaos/bark-worker` 或其他专用 Bark server。

### Gotify / PushPlus / ntfy / Slack / Discord / Alertmanager / Pushover / Apprise 兼容

| 协议 | 兼容入口 | 鉴权 |
| --- | --- | --- |
| Gotify | `POST /message` | `X-Gotify-Key` 头、`?token=` 查询参数或 `Authorization: Bearer`，值均为 Agent Key |
| PushPlus | `GET/POST /send` | `token` 参数使用 Agent Key |
| ntfy | `POST /ntfy/<destination>` | `Authorization: Bearer <AgentKey>` |
| Slack Incoming Webhook | `POST /services/<T>/<B>/<AgentKey>` | URL 末段为 Agent Key；成功返回纯文本 `ok` |
| Discord Webhook | `POST /api/webhooks/<id>/<AgentKey>` | URL 末段为 Agent Key；支持 `?wait=true` |
| Alertmanager / Grafana | `POST /alertmanager?key=<AgentKey>` | `?key=` 或 Bearer；`alerts[]` 逐条转通知，fingerprint 幂等去重 |
| Pushover | `POST /1/messages.json` | `token` 或 `user` 字段为 Agent Key；priority 为 -2..2 刻度 |
| Apprise API | `POST /notify/<AgentKey>` | URL 中的 Agent Key 或 Bearer；`type` 映射严重级别 |

Slack 端点意味着任何有「Slack webhook URL」输入框的工具——GitHub、GitLab、Grafana、Sentry、Prometheus、Jenkins、Uptime Kuma、Datadog——把 URL 原样指向 Walkie 即可。Gotify 和 PushPlus 在 Agent Key 只绑定一个目的地时可直接发送；ntfy 用路径中的 `destination` 指定频道或路由。完整参数和各协议官方文档可在「系统 → 实例状态 → 全屏查看兼容端点」中直接查看。

## 双向确认是怎么工作的

```
Agent ── ask_user("要不要回滚？", 选项) ──► Walkie
Walkie ── 推送问题 + 一次性链接 ──► 你的手机（任意已配置渠道）
你     ── 点选项或输入回复（或直接在控制台「会话」页回） ──► Walkie
Agent  ── check_reply 长轮询 ──► 拿到答案，继续执行
```

链接一次有效、到期作废（30 秒 ~ 24 小时可调），无需给回复者任何账号。

### 直接在聊天软件里回，不用点链接

Telegram、Slack、Discord 都能就地闭环。打开「频道 → 编辑」，里面的**双向回调地址**由 bot token 派生，不需要额外配置项：

| 渠道 | URL 填到哪 | 能做什么 |
| --- | --- | --- |
| Telegram | `setWebhook`（URL 末段同时作为 `secret_token`） | 按钮点按即回、直接回一句话即作答、其余消息进 Agent 收件箱 |
| Slack | *Interactivity & Shortcuts → Request URL*（按钮）与 *Event Subscriptions → Request URL*（消息，订阅 `message.channels`） | Block Kit 按钮、频道里回一句话即作答、其余消息进收件箱 |
| Discord | *General Information → Interactions Endpoint URL* | 按钮点按即回 |

```bash
# Telegram 一条命令搞定
curl "https://api.telegram.org/bot<BotToken>/setWebhook" \
  -d "url=https://你的域名/telegram/webhook/<secret>" \
  -d "secret_token=<secret>"
```

只接受频道里配置的那个 chat / channel，找到这个机器人的陌生人无法替你回答。

**关于验签**：Discord 强制 Ed25519 验签，必须先在频道表单里填 Application Public Key，否则 Discord 保存端点时的探测就过不去。Slack 填了 App 的 Signing Secret 就启用官方 `X-Slack-Signature` 验签；留空则回调 URL 里的高熵密钥本身是唯一凭据。Telegram 用它自己的 `secret_token` 头。

**Discord 没有自由文本回复**：Discord 只把 *interaction* 推到 HTTP webhook，普通聊天消息要常驻 Gateway(WebSocket) 连接才收得到，Serverless 部署撑不住。所以按钮可用，「在频道里回一句话」不可用。

### 反方向——你主动找 Agent

长任务跑到一半也能改方向。在控制台「会话 → 发消息给 Agent」输入，或在没有待回复问题时直接给 Telegram 机器人发消息；Agent 下一次调用 `wait_for_inbox` 就会读到，每条消息只被取走一次。这是最可靠的推送路径：绝大多数 MCP 客户端会丢弃服务端主动下发的 notification，但没有客户端会丢弃 tool 结果。

### 盯住 Claude Code / Cursor 会话（hooks）

编码 Agent 干完了、失败了、在等你授权——都推到你手机上，不用守着终端。建一个只绑单个目的地的 Agent Key，把工具的 hook 指到 `POST /api/v1/hooks/claude`，事件 JSON 会按下表翻译成通知：

| 事件 | 级别 |
| --- | --- |
| `Notification` `permission_prompt` / `agent_needs_input` / `elicitation_*`——在等你 | critical |
| `StopFailure`——回合因 API 错误中断 | critical |
| `Stop` / `agent_completed`——任务完成 | success |
| `idle_prompt` / `SubagentStop` | info |
| `SessionEnd`、`PreToolUse` 等高频事件 | 收下但不发（防轰炸） |

**Claude Code（v2.1+，零脚本）。** hook 原生支持 `type: "http"`，`~/.claude/settings.json` 里直接配：

```json
{
  "hooks": {
    "Notification": [
      { "matcher": "permission_prompt|idle_prompt|agent_needs_input|agent_completed", "hooks": [
        { "type": "http", "url": "https://你的域名/api/v1/hooks/claude",
          "headers": { "Authorization": "Bearer $WALKIE_TOKEN" }, "allowedEnvVars": ["WALKIE_TOKEN"] }
      ] }
    ],
    "Stop": [
      { "hooks": [ { "type": "http", "url": "https://你的域名/api/v1/hooks/claude",
          "headers": { "Authorization": "Bearer $WALKIE_TOKEN" }, "allowedEnvVars": ["WALKIE_TOKEN"] } ] }
    ],
    "StopFailure": [
      { "hooks": [ { "type": "http", "url": "https://你的域名/api/v1/hooks/claude",
          "headers": { "Authorization": "Bearer $WALKIE_TOKEN" }, "allowedEnvVars": ["WALKIE_TOKEN"] } ] }
    ]
  }
}
```

`WALKIE_TOKEN` 从环境变量读取，密钥不会落进配置文件。key 绑了多个目的地时，在 URL 后面加 `?destination=<slug>`。

**Cursor。** Cursor 的 hook 只有 command 类型；用仓库里的转发脚本 [`scripts/cursor-hook-notify.sh`](scripts/cursor-hook-notify.sh)（把事件 JSON POST 到同一个端点，永远 exit 0，绝不阻塞工作流）：

```json
{
  "version": 1,
  "hooks": {
    "stop": [ { "command": "./scripts/cursor-hook-notify.sh", "timeout": 15 } ],
    "postToolUseFailure": [ { "command": "./scripts/cursor-hook-notify.sh", "timeout": 15 } ],
    "sessionEnd": [ { "command": "./scripts/cursor-hook-notify.sh", "timeout": 5 } ]
  }
}
```

环境变量设 `WALKIE_URL` 和 `WALKIE_TOKEN`（可选 `WALKIE_DESTINATION`）；没配置的机器保持静默，所以 hooks 文件可以随仓库分发。

### Web Push——不依赖任何第三方账号

「系统 → Web Push → 订阅本设备」把当前浏览器（桌面或手机）注册到实例自己生成的 VAPID 密钥对上。再新建一个 `Web Push（本站订阅）` 频道并设为目的地即可；载荷按 RFC 8291 端到端加密。需要 HTTPS；iOS 上要先把站点「添加到主屏幕」。

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
- 「系统」页可配置数据保留策略和通知量软限制；用量每 30 秒刷新，过期数据可自动或手动清理。

## 常见问题

**忘记管理密码？** 设置一个新的 env 密码即可：Cloudflare 用 `wrangler secret put ADMIN_TOKEN`；Docker/Node 改环境变量后重启。登录后可在「密钥」页创建多条管理密码并逐条撤销；环境变量密码只能在部署平台修改或移除。系统会阻止撤销最后一条有效凭据。

**换设备后 Agent Key 丢了？** 「密钥」页可直接查看并复制（明文加密存储）；也可以吊销后重建。

**启动报「MASTER_KEY 与该数据库不匹配」？** 说明当前 `MASTER_KEY` 不是创建这份数据时用的那一把（换过密钥、恢复备份时漏带、或多个环境共用了同一个数据目录）。把原密钥换回去即可，Walkie 不会用错误的密钥继续写入。密钥确实丢失时，渠道凭据无法恢复，只能清空数据目录/数据库重建。

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

架构：`src/server`（Express + 队列 + 渠道调度，Node/Vercel/Workers 共用核心）、`src/worker`（Cloudflare Durable Object 入口）、`src/web`（React 控制台）、`api/`（Vercel 入口）。添加新渠道见 [CONTRIBUTING.md](CONTRIBUTING.md)，待实现的扩展项见 [docs/roadmap.md](docs/roadmap.md)。

## License

[MIT](LICENSE)
