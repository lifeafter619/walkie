# RelayDock

> The notification control plane built for AI agents.

![License](https://img.shields.io/badge/license-MIT-blue) ![Node](https://img.shields.io/badge/node-%E2%89%A522-brightgreen) ![Deploy](https://img.shields.io/badge/deploy-Docker%20%7C%20Cloudflare%20Workers%20%7C%20Vercel-orange) ![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-8A2BE2)

RelayDock 是一个面向 AI Agent 的自托管通知控制面。Agent 通过 MCP 或 REST API 提交结构化通知，RelayDock 负责凭据隔离、路由编排、异步重试、投递审计，并把消息送到团队已有的协作与推送平台。

它吸收了 [Message Pusher](https://github.com/songquanpeng/message-pusher) 的三个关键思路：大量内置渠道、频道群组、可扩展自定义请求；同时针对 Agent 使用场景加入 MCP、细粒度 API Key、目的地白名单、幂等与 SSRF 防护。

## 核心能力

- React 管理面板：概览、快速发送、频道、路由、投递详情、Agent Key 与系统状态；明暗主题跟随系统并可手动切换。
- MCP Streamable HTTP：`list_destinations`、`list_routes`、`send_notification`、`get_delivery`、`ask_user`、`check_reply`。
- 双向确认：Agent 用 `ask_user` 把问题推到手机，人从任意渠道打开一次性回复链接作答，`check_reply` 长轮询取回答案——Agent 可以远程等人拍板再继续。
- Server 酱兼容入口：`/send/{AgentKey}.send`，2000+ 已集成 Server 酱的软件可直接把 RelayDock 当推送后端。
- 路由策略：`fanout` 并发广播；`fallback` 按顺序尝试，首次成功后停止。
- 投递治理：每频道限流（次/分钟）、静默时段（critical 穿透）、消息 `tags` 与卡片简述 `short` 透传。
- SQLite 持久队列：指数退避、失败恢复、幂等键、每频道 Attempt 与审计事件。
- 安全边界：AES-256-GCM 凭据加密、Agent Key 哈希存储、scope、目的地白名单、默认阻止 HTTP/私网 webhook。
- 单体部署：一个 Node.js 进程和一个 SQLite 文件，无需 Redis 或外部数据库。
- 三种部署形态：Docker/Node 单体（本地 SQLite）、Cloudflare Workers（SQLite-backed Durable Object + alarm 重试）、Vercel（Turso/libSQL + Cron 重试），同一套面板、MCP 与 REST。

## 为什么是 RelayDock

现有工具各占一角：message-pusher/Apprise 有渠道广度但没有 MCP 与 Agent 凭据隔离；ntfy/Gotify 有 token 模型但只推自家客户端；MCP 通知类小工具全是无状态 stdio 薄包装——bot token 直接塞给 Agent，没有队列、审计和 UI。RelayDock 把四件事放进同一个自托管进程：

| | Apprise / message-pusher | ntfy / Gotify | MCP 通知小工具 | RelayDock |
|---|---|---|---|---|
| 渠道广度 | ✅ | 自有客户端 | 3~5 个 | ✅ 25+ |
| 持久队列/重试/fallback | ❌（目标挂了即丢） | 部分 | ❌ | ✅ SQLite 队列 |
| MCP 原生接入 | ❌ | ❌ | ✅ | ✅ Streamable HTTP |
| Agent 级 Key/白名单/审计/幂等 | ❌ | 部分 | ❌ | ✅ |

## 支持渠道

| 类别 | 内置适配器 |
|---|---|
| 聊天协作 | Telegram、企业微信、飞书/Lark、钉钉、Slack、Discord、Microsoft Teams、Google Chat、Mattermost、Rocket.Chat、Zulip、Webex、Matrix、QQ (OneBot/NapCat)、Synology Chat、LINE |
| 移动推送 | ntfy、Gotify、Pushover、Pushbullet、Bark、Server 酱（Turbo 与 Server酱³ 按 SendKey 自动识别）、PushDeer、Chanify、PushMe、PushPlus、WxPusher、息知、Qmsg 酱 |
| 邮件与短信 | SMTP、Twilio SMS |
| 通用扩展 | Generic Webhook、Apprise API（可继续连接 100+ 服务）、PagerDuty (Events v2) |

渠道高级参数：Telegram `parse_mode`/话题线程、ntfy 优先级/Tags、Bark 铃声/图标/critical 持续响铃与音量、Pushover 铃声、飞书卡片标题色（可固定或按 severity 自动）、Gotify critical 自动提升优先级等，均在频道表单按渠道展示。

## 本地开发

要求 Node.js 22 或更高版本。当前工程在 Node.js 24 上验证。

```powershell
npm ci
npm run dev
```

另开一个终端启动前端开发服务器：

```powershell
npm run dev:web
```

打开 `http://127.0.0.1:5173`。默认只监听回环地址；本地未设置 `ADMIN_TOKEN` 时管理 API 免鉴权。

生产构建：

```powershell
npm run build
$env:NODE_ENV = 'production'
$env:ADMIN_TOKEN = 'replace-with-at-least-24-random-characters'
$env:MASTER_KEY = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
npm start
```

生产模式必须提供 `ADMIN_TOKEN` 与 32 字节 Base64 `MASTER_KEY`。更换已有实例的 `MASTER_KEY` 会导致历史频道凭据无法解密。

## Docker Compose

先设置两个环境变量，再启动：

```powershell
$env:ADMIN_TOKEN = 'replace-with-at-least-24-random-characters'
$env:MASTER_KEY = [Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
docker compose up -d --build
```

面板位于 `http://127.0.0.1:4310`，数据保存在 `relaydock-data` volume。

## Cloudflare Workers 完整部署

Workers 版本包含完整管理面板、远程 HTTP MCP、REST、Agent Key、频道、路由、投递记录和后台重试，不需要额外数据库。状态存储在名为 `default` 的 SQLite-backed Durable Object 中。

要求：已安装并登录 Wrangler。首次部署前设置两个 secret：

```powershell
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put MASTER_KEY
```

- `ADMIN_TOKEN`：至少 24 个字符，用于登录管理面板。
- `MASTER_KEY`：32 字节随机值的 Base64 文本。可用 PowerShell 生成：

```powershell
[Convert]::ToBase64String([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
```

然后部署：

```powershell
npm run deploy:cf
```

Wrangler 会构建 React 面板、部署 Worker、创建 Durable Object migration，并输出 `https://<worker>.workers.dev`。远程 MCP 地址就是：

```text
https://<worker>.workers.dev/mcp
```

本地验证 Workers 运行时：

```powershell
# 在未提交的 .dev.vars 中填写 ADMIN_TOKEN 和 MASTER_KEY
npm run dev:cf
```

Workers 的 HTTP 渠道与 Node 版共用适配器。SMTP 必须使用 Cloudflare Workers 允许的 TCP 端口，不能使用端口 `25`；推荐 `465` 或 `587`。默认仍禁止明文 HTTP 和私网目标。

## Vercel 部署

Vercel Functions 没有持久文件系统，RelayDock 在 Vercel 上使用 [Turso](https://turso.tech)（libSQL）作为存储：投递在请求内完成首发（`waitUntil` 保证响应后跑完），失败重试由 Vercel Cron 每 10 分钟扫队列兜底（`vercel.json` 可调；Hobby 计划 Cron 最短每天一次，重试会更慢）。

1. 创建 Turso 数据库，拿到 `TURSO_DATABASE_URL` 与 `TURSO_AUTH_TOKEN`。
2. Vercel 项目导入本仓库，设置环境变量：

   | 变量 | 说明 |
   |---|---|
   | `TURSO_DATABASE_URL` | `libsql://<db>.turso.io` |
   | `TURSO_AUTH_TOKEN` | Turso 数据库令牌 |
   | `ADMIN_TOKEN` | ≥24 字符管理令牌 |
   | `MASTER_KEY` | 32 字节 Base64 主密钥 |
   | `CRON_SECRET` | 保护 `/api/cron/drain` 的随机值（Vercel Cron 自动携带） |

3. 部署即可；入口为 `api/index.ts`，面板与 MCP 与其他形态完全一致。

## MCP 接入

在面板的 **Agents** 页面创建 API Key。原始 Key 只显示一次；RelayDock 数据库只保存哈希。

管理面板的 **接入** 页面可直接复制 Codex、Claude Code、Cursor 与通用客户端配置。所有客户端都连接同一个 Streamable HTTP 地址：`https://<domain>/mcp`。

通用 MCP 客户端配置：

```json
{
  "mcpServers": {
    "relaydock": {
      "type": "http",
      "url": "https://notify.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${RELAYDOCK_API_KEY}"
      }
    }
  }
}
```

典型调用顺序：

1. `list_destinations` 获取该 Agent 有权使用的 ID/slug。
2. `send_notification` 提交 `destination`、`title`、`body`、`severity`，可选 `url`、`metadata`、`idempotencyKey`。
3. `get_delivery` 用返回的 `deliveryId` 查询每个渠道的最终状态。
4. 需要人工决策时：`ask_user` 提交 `destination` 与 `question`（可带 `options` 预设选项，回复页渲染为按钮，也支持自由输入），拿到 `conversationId`；轮询 `check_reply`（服务端长轮询最多 25 秒/次）直到 `status` 为 `replied`，`reply` 即人的回答。问题会推送到渠道并附一次性回复链接，手机浏览器打开即可作答，无需安装任何客户端；回复链接有效期由 `timeoutSeconds` 控制（默认 1 小时）。REST 等价接口：`POST /api/v1/ask` 与 `GET /api/v1/conversations/{id}`；管理面板也可通过 `GET /api/admin/conversations?pending=1` 与 `POST /api/admin/conversations/{id}/reply` 代答。

Agent 不能提交 webhook URL 或平台凭据，只能引用管理员预先配置并授权的目的地。

### Codex

Codex CLI、桌面端和 IDE 扩展共享 `~/.codex/config.toml`；可信项目也可以使用 `.codex/config.toml`：

```toml
[mcp_servers.relaydock]
url = "https://notify.example.com/mcp"
bearer_token_env_var = "RELAYDOCK_API_KEY"
default_tools_approval_mode = "writes"
```

在启动 Codex 的环境中设置 `RELAYDOCK_API_KEY`，然后用 `/mcp` 检查连接。不要把原始 Key 写进项目配置。

### Claude Code

项目根目录 `.mcp.json`：

```json
{
  "mcpServers": {
    "relaydock": {
      "type": "http",
      "url": "https://notify.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${RELAYDOCK_API_KEY}"
      }
    }
  }
}
```

也可以用 CLI：

```powershell
claude mcp add --transport http relaydock https://notify.example.com/mcp --header "Authorization: Bearer $env:RELAYDOCK_API_KEY"
```

### Cursor

项目配置 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "relaydock": {
      "url": "https://notify.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${env:RELAYDOCK_API_KEY}"
      }
    }
  }
}
```

### 自研 Agent

使用任意 MCP SDK 的 Streamable HTTP client，向 `/mcp` 发送 `Authorization: Bearer <Agent API Key>`。RelayDock 是无状态 MCP 服务，不要求粘性会话；客户端应同时接受 `application/json` 和 `text/event-stream`。典型调用顺序是 `list_destinations` → `send_notification` → `get_delivery`。

## REST API

Agent API 使用同一个 Bearer Key：

```http
POST /api/v1/notify
Authorization: Bearer rdk_xxxxxxxx_xxxxxxxxxxxxxxxxx
Content-Type: application/json

{
  "destination": "prod-incidents",
  "title": "数据库连接池耗尽",
  "body": "checkout-service 已连续 5 分钟超过阈值",
  "severity": "critical",
  "url": "https://monitor.example.com/incidents/1842",
  "metadata": { "service": "checkout-service", "region": "ap-southeast-1" },
  "idempotencyKey": "incident-1842-open"
}
```

查询状态：

```http
GET /api/v1/deliveries/{deliveryId}
Authorization: Bearer rdk_xxxxxxxx_xxxxxxxxxxxxxxxxx
```

`POST /api/v1/notify` 还接受可选的 `tags`（竖线分隔标签）、`short`（卡片简述）与 `callbackUrl`：投递到达终态（delivered/partial/failed）后，RelayDock 会向 `callbackUrl` POST 一次最终结果（含每渠道状态），Agent 无需轮询即可获知推送成败。MCP 的 `send_notification` 同样支持 `callbackUrl`。

## Server 酱兼容入口

任何已集成 Server 酱的软件（Check酱、各类监控脚本等）只需把 API 地址换成 RelayDock，SendKey 填 Agent API Key：

```text
GET/POST https://notify.example.com/send/rdk_xxxxxxxx_xxxxxxxxxxxxxxxxx.send?title=标题&desp=正文
```

- 参数与 Server酱³ 一致：`title`/`text`、`desp`、`tags`、`short`；支持 Query、表单和 JSON。
- 目的地：Key 白名单只配置了一个目的地时自动使用；否则加 `destination=<slug>` 参数。
- 响应为 Server 酱风格 `{ "code": 0, "data": { "pushid": "..." } }`，`pushid` 即 deliveryId。

## 投递治理

每个频道可单独配置：

- **每分钟限流**：超出的消息自动延后重新排队，不计入重试次数。
- **静默时段**：如 `22:00-08:00`（服务器本地时间），静默期内消息延后到时段结束发送；`critical` 级别照常送达。
- **长消息分片**：超过渠道正文上限（Telegram 4096、企业微信 4K 字节等）自动按换行切分为多条，标题附 `(1/n)` 序号，链接只挂最后一条。

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---:|---|
| `HOST` | `127.0.0.1` | 监听地址；非回环地址必须设置管理令牌 |
| `PORT` | `4310` | HTTP 端口 |
| `DATA_DIR` | `./data` | SQLite 数据目录 |
| `ADMIN_TOKEN` | 无 | 管理面板/API Bearer Token，生产必填且至少 24 字符 |
| `MASTER_KEY` | 本地开发键 | 32 字节 Base64 加密主密钥，生产必填 |
| `ALLOW_PRIVATE_WEBHOOKS` | `false` | 允许解析到私网/回环地址的目标 |
| `ALLOW_INSECURE_HTTP` | `false` | 允许明文 HTTP 目标 |
| `DELIVERY_WORKERS` | `2` | 每轮并发投递数，范围 1–16 |
| `MAX_SENDS_PER_MIN` | `0` | 全局每分钟最大推送条数，0 不限 |
| `MAX_DELIVERY_ATTEMPTS` | `4` | 单频道最大尝试次数，范围 1–10 |
| `RETRY_BASE_MS` | `2000` | 指数退避基准时间 |
| `PUBLIC_URL` | 请求来源 | Node/Docker 对外规范地址，面板据此生成 MCP 配置 |
| `TURSO_DATABASE_URL` | 无 | 设置后改用 Turso/libSQL 远程库（Vercel 部署必填） |
| `TURSO_AUTH_TOKEN` | 无 | Turso 数据库令牌 |
| `CRON_SECRET` | 无 | Vercel Cron 调用 `/api/cron/drain` 的鉴权令牌 |

## 架构

```text
AI Agent ── MCP / REST ──┐
                         ├── Express API ── SQLite
管理员 ── React 面板 ────┘        │
                                  └── Delivery Worker ── Provider adapters
```

MCP 使用无 session 的 Streamable HTTP transport；每个请求创建轻量 `McpServer`。Node/Docker 使用 WAL SQLite 和进程级投递循环；Cloudflare Workers 使用 SQLite-backed Durable Object 串行化状态，并由 alarm 恢复到期重试。

## Roadmap

按对 Agent 场景的价值排序（欢迎 PR）：

- [x] 投递终态回调 `callbackUrl`、全局限流 `MAX_SENDS_PER_MIN`
- [x] 渠道扩充至 30+（QQ/OneBot、PushDeer、Chanify、PushMe、Synology Chat、PagerDuty、LINE）与渠道级优先级/铃声/颜色参数
- [ ] severity 规则路由：`critical` 自动 fanout 到多渠道
- [ ] 飞书/企业微信应用消息（token 交换，可私聊指定人）、WhatsApp Cloud API
- [x] 长消息按渠道上限自动分片（Telegram/企业微信/钉钉/Discord 等，分片带序号）
- [ ] Markdown 跨渠道降级（Telegram MarkdownV2 / 飞书卡片 / 纯文本）
- [ ] 附件与图片透传（Bark/ntfy/Telegram）
- [x] 双向确认 `ask_user`/`check_reply`：一次性回复链接，任意渠道可用
- [ ] 时间窗 digest 聚合，防高频 Agent 通知轰炸
- [ ] 英文 README 与在线演示实例

## 当前限制

- 第一版只支持文本、Markdown、链接和基础卡片，不处理附件上传、图片二进制或平台交互回调。
- 使用静态 Bearer Agent Key，尚未实现 MCP OAuth/动态客户端注册。
- 自定义 Webhook 的地址在请求前检查 DNS，但未做出站代理级 IP 固定；高安全环境应配合网络 egress policy。
- SQLite 适合单机和中等通知吞吐；多地域高可用需要外部数据库与专用队列后端。
- Cloudflare Workers 部署当前固定为一个 Durable Object 实例，语义与单机版一致；它不是多活分片架构。
- `@modelcontextprotocol/node@2.0.0` 当前通过 `@hono/node-server` 带有一个 Windows 静态文件路径穿越的上游中危审计项。RelayDock 不使用该静态文件实现，面板由 Express 托管；仍应在上游发布修复后升级。

## 验证

```powershell
npm test
npm run typecheck
npm run build
```

## License

[MIT](LICENSE)
