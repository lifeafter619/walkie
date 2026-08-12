# RelayDock

RelayDock 是一个面向 AI Agent 的自托管通知控制面。Agent 通过 MCP 或 REST API 提交结构化通知，RelayDock 负责凭据隔离、路由编排、异步重试、投递审计，并把消息送到团队已有的协作与推送平台。

它吸收了 [Message Pusher](https://github.com/songquanpeng/message-pusher) 的三个关键思路：大量内置渠道、频道群组、可扩展自定义请求；同时针对 Agent 使用场景加入 MCP、细粒度 API Key、目的地白名单、幂等与 SSRF 防护。

## 第一版能力

- React 管理面板：概览、快速发送、频道、路由、投递详情、Agent Key 与系统状态。
- MCP Streamable HTTP：`list_destinations`、`list_routes`、`send_notification`、`get_delivery`。
- Server 酱兼容入口：`/send/{AgentKey}.send`，2000+ 已集成 Server 酱的软件可直接把 RelayDock 当推送后端。
- 路由策略：`fanout` 并发广播；`fallback` 按顺序尝试，首次成功后停止。
- 投递治理：每频道限流（次/分钟）、静默时段（critical 穿透）、消息 `tags` 与卡片简述 `short` 透传。
- SQLite 持久队列：指数退避、失败恢复、幂等键、每频道 Attempt 与审计事件。
- 安全边界：AES-256-GCM 凭据加密、Agent Key 哈希存储、scope、目的地白名单、默认阻止 HTTP/私网 webhook。
- 单体部署：一个 Node.js 进程和一个 SQLite 文件，无需 Redis 或外部数据库。

## 支持渠道

| 类别 | 内置适配器 |
|---|---|
| 聊天协作 | Telegram、企业微信、飞书/Lark、钉钉、Slack、Discord、Microsoft Teams、Google Chat、Mattermost、Rocket.Chat、Zulip、Webex、Matrix |
| 移动推送 | ntfy、Gotify、Pushover、Pushbullet、Bark、Server 酱（Turbo 与 Server酱³ 按 SendKey 自动识别）、PushPlus、WxPusher、息知、Qmsg 酱 |
| 邮件与短信 | SMTP、Twilio SMS |
| 通用扩展 | Generic Webhook、Apprise API（可继续连接 100+ 服务） |

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

## MCP 接入

在面板的 **Agents** 页面创建 API Key。原始 Key 只显示一次；RelayDock 数据库只保存哈希。

通用 MCP 客户端配置：

```json
{
  "mcpServers": {
    "relaydock": {
      "type": "http",
      "url": "https://notify.example.com/mcp",
      "headers": {
        "Authorization": "Bearer rdk_xxxxxxxx_xxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

典型调用顺序：

1. `list_destinations` 获取该 Agent 有权使用的 ID/slug。
2. `send_notification` 提交 `destination`、`title`、`body`、`severity`，可选 `url`、`metadata`、`idempotencyKey`。
3. `get_delivery` 用返回的 `deliveryId` 查询每个渠道的最终状态。

Agent 不能提交 webhook URL 或平台凭据，只能引用管理员预先配置并授权的目的地。

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

`POST /api/v1/notify` 还接受可选的 `tags`（竖线分隔标签）与 `short`（卡片简述），会透传到 Server酱³、WxPusher 等支持的渠道。

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
| `MAX_DELIVERY_ATTEMPTS` | `4` | 单频道最大尝试次数，范围 1–10 |
| `RETRY_BASE_MS` | `2000` | 指数退避基准时间 |

## 架构

```text
AI Agent ── MCP / REST ──┐
                         ├── Express API ── SQLite
管理员 ── React 面板 ────┘        │
                                  └── Delivery Worker ── Provider adapters
```

MCP 使用无 session 的 Streamable HTTP transport；每个请求创建轻量 `McpServer`，数据库和队列在进程级共享。SQLite 使用 WAL，队列状态持久化，进程重启后会继续处理到期任务。

## 当前限制

- 第一版只支持文本、Markdown、链接和基础卡片，不处理附件上传、图片二进制或平台交互回调。
- 使用静态 Bearer Agent Key，尚未实现 MCP OAuth/动态客户端注册。
- 自定义 Webhook 的地址在请求前检查 DNS，但未做出站代理级 IP 固定；高安全环境应配合网络 egress policy。
- SQLite 适合单机和中等通知吞吐；多地域高可用需要外部数据库与专用队列后端。
- `@modelcontextprotocol/node@2.0.0` 当前通过 `@hono/node-server` 带有一个 Windows 静态文件路径穿越的上游中危审计项。RelayDock 不使用该静态文件实现，面板由 Express 托管；仍应在上游发布修复后升级。

## 验证

```powershell
npm test
npm run typecheck
npm run build
```

## License

[MIT](LICENSE)
