# 扩展路线（Roadmap）

本文记录 Walkie 的竞品定位与待实现的扩展项。所有外部 API 契约与平台事实都已核实并附来源，实现时不必重新调研。

调研时间：2026-08-20。平台策略会变，动手前建议复核标注了「以官方页面为准」的条目。

> **进度（2026-08-21）**：全部条目已实现——第一梯队 1–5（Slack / Discord / Alertmanager / Pushover / Apprise 兼容端点）、#16（英文 README）、#6 Web Push（VAPID ES256 + RFC 8291，含订阅管理与 Service Worker）、#7 Slack/Discord Bot、#8 飞书应用 + 钉钉工作通知、#9 AWS SES v2、#11 Telegram 内联按钮 + webhook 回调、#12 stdio 包装（`packages/walkie-mcp`）、#13 idle gating（MCP `report_idle`）、#14 `/openapi.json`、#15 CLI 与 GitHub Action（`packages/walkie-cli` + `.github/workflows/notify.yml`）。顺带修复审计发现的 DO alarm 250ms 死循环与 MCP URL scheme 校验缺口。Opsgenie 按考证拒绝（见 #10 位置的说明）。

---

## 一、竞品格局

市场分成两个赛道，**中间是空的**——这就是 Walkie 的位置。

### A 类 · 自托管通知网关

| 项目 | 形态 | 强项 | 短板 |
| --- | --- | --- | --- |
| [ntfy](https://ntfy.sh) | Go 单二进制，topic pub/sub，Apache-2.0 | 这一类里唯一有维护良好的 iOS 客户端；自托管极简 | 只有自己一个渠道；无双向；无 MCP |
| [Gotify](https://gotify.net) | WebSocket + 每应用 token | 简单稳定 | 架构僵硬，只有 Android 客户端 |
| [Apprise API](https://github.com/caronc/apprise-api) | Python 库 + REST 包装 | 100+ 服务覆盖 | 无 UI、无投递记录、无重试、无双向 |
| Novu / Knock / Courier | 商业通知编排 | 工作流、模板、订阅者管理 | 要订阅付费；自托管版能力受限 |

### B 类 · Agent 通知 / human-in-the-loop MCP（2026 年井喷）

omni-notify-mcp（BullseyeNotif）、ping-a-human、tasksync-mcp、halobot、pheme、page-user、your-turn-mcp、hi、ask-user-questions-mcp。

共同特征：

- 渠道极少——绝大多数只接 Telegram 或 Discord **一家**；pheme 靠包 Apprise 绕过这一点
- 配置靠环境变量明文，没有加密、没有 scope、没有审计
- 没有控制台、没有投递记录、没有重试队列
- 多为 stdio MCP，零部署起步（这是它们的优势）

值得单独关注的两个：

- **omni-notify-mcp**：notify / ask / poll / `wait_for_inbox` 长轮询，带 idle gating 与 DND，声明了 Claude Code 的 `claude/channel` capability
- **tasksync-mcp**：反馈循环 + 图片附件 + Telegram 快捷回复按钮

---

## 二、Walkie 已有的独有优势（要继续放大）

1. **兼容端点矩阵**——Server酱 / Bark / Gotify / ntfy / PushPlus 协议 relay。**两个赛道的竞品全都没有。** 存量脚本零改造迁移，这是最锋利的差异点，第一梯队的扩展全部围绕它。
2. **75+ 原生渠道 + 双向 ask/reply + 控制台 + 投递审计**，四者合一。
3. **中国渠道深度**：企业微信应用 / 飞书 / 钉钉 / QQ 官方机器人 / KOOK / WxPusher / 华为 / 小米 / OPPO / vivo / 魅族 / 极光 / 个推。西方项目基本为零。
4. **一份代码四平台**（Cloudflare Workers / Vercel / Docker / 裸机），Workers 上零外部数据库。
5. **凭据 KEK/DEK 加密 + 在线轮换 + scope 与目的地白名单 + 审计日志**。
6. **`config:write`**——Agent 用自然语言给自己配渠道并测试连通。独一份。
7. **平台额度监控 + 超阈值自动暂停**。独一份。

## 三、相对竞品的短板

| 短板 | 谁做得比我们好 | 对应扩展项 |
| --- | --- | --- |
| 没有自有移动 App | ntfy / Gotify / Bark | #6 Web Push |
| 没有 stdio MCP，必须先部署 | B 类几乎全部 | #12 stdio 包装 |
| 回复要点一次性链接 | ping-a-human / tasksync（Telegram 内联按钮直接回） | #11 Telegram 按钮回调 |
| 没有 idle gating / DND | omni-notify-mcp | #13 |
| README 全中文 | — | #16 |

---

## 四、扩展清单

### 第一梯队 · 兼容端点（ROI 最高）

把"存量迁移"这个独有优势拉满。每项都是几十行 adapter，复用现有的 `sendWithAgentKey` + `notifications.send`，实现位置与现有兼容端点相同：`src/server/app.ts`（Node/Vercel）与 `src/worker/index.ts`（Workers）**必须双端同步**，并在 `src/shared/platform.ts` 的 `COMPATIBILITY_ENDPOINTS` 登记，控制台「接入」页会自动展示。

#### 1. Slack Incoming Webhook 兼容 —— 优先级最高

```
POST /services/<T…>/<B…>/<xxx>
```

任何有「Slack webhook URL」输入框的工具都能直接指过来：GitHub、GitLab、Grafana、Sentry、Prometheus、Jenkins、Uptime Kuma、Datadog……**这是整份清单里覆盖面最广的一项。**

- 路径三段中取一段（建议末段）作为 Agent Key
- 请求体取 `text`；有 `blocks` / `attachments` 时降级提取纯文本
- 兼容 `payload=<urlencoded json>` 的老式表单提交
- 成功返回纯文本 `ok`（Slack 的行为，不是 JSON）
- 注意：现有的 Bark 旧式路径正则会吃掉多段路径，新路由必须注册在它**之前**

#### 2. Discord Webhook 兼容

```
POST /api/webhooks/<id>/<token>
```

- 取 `content`，`embeds[].title` / `.description` 作为补充
- 支持 `?wait=true`：返回一个 message 对象而不是 204
- 注意：路径以 `/api/` 开头，Worker 入口的 `path.startsWith('/api/')` 分流已经覆盖，但 `app.ts` 里要放在 `/api/admin` 与 `/api/v1` 之后

#### 3. Alertmanager / Grafana Webhook Receiver

```
POST /alertmanager
```

Prometheus 生态直连。解析标准 webhook payload 的 `alerts[]`，逐条转成通知：

- `status: firing|resolved` → severity（firing 且 `labels.severity=critical` → critical）
- `labels.alertname` → title，`annotations.summary` / `.description` → body
- `generatorURL` → url
- `fingerprint` → `idempotencyKey`（天然幂等，重复推送不会刷屏）
- Grafana 统一告警的 webhook 格式与 Alertmanager 兼容，同一个端点即可

#### 4. Pushover 兼容

```
POST /1/messages.json
```

契约已核实（来源：<https://pushover.net/api>）：

- 必填 `token`、`user`、`message`；`token` 或 `user` 任一作为 Agent Key
- 可选 `title` / `url` / `url_title` / `priority` / `sound` / `device` / `html` / `timestamp` / `ttl`
- `priority` 刻度为 **-2 / -1 / 0 / 1 / 2**（与 Gotify 的 0–10、ntfy 的 1–5 都不同，必须给 `prioritySeverity()` 加第三种 scale——参考 `src/server/compat.ts` 里已经踩过的那个坑）
- 成功返回 `{"status":1,"request":"<uuid>"}`

#### 5. Apprise API 兼容

```
POST /notify          （无状态，payload 带 urls）
POST /notify/<KEY>    （持久配置）
```

契约已核实（来源：<https://github.com/caronc/apprise-api>）：

- `body` 必填；`title` / `type` / `tag` / `format` 可选
- `type` 取值 `info` | `success` | `warning` | `failure`（映射到 severity：failure → critical）
- `format` 取值 `text` | `markdown` | `html`
- `<KEY>` 用作 Agent Key；无 KEY 时用 Bearer
- 同时接受 JSON 与 `application/x-www-form-urlencoded`

> **顺带修一个已知缺口**：Gotify 官方示例大量使用 `curl -F`（`multipart/form-data`），Express 与 workerd 目前都不解析。要覆盖需要一个 multipart 解析器；如果只是为了兼容端点，写一个最小的 boundary 切分即可，不必引入依赖。

### 第二梯队 · 渠道

#### 6. Web Push (VAPID)

**补上「没有自有 App」这个短板的最省力做法。** 不依赖任何第三方账号，浏览器与桌面直达，控制台自己就能订阅。

- VAPID JWT 用 ES256 签名，`globalThis.crypto.subtle` 在 Node 与 workerd 上都可用——`dispatcher.ts` 里已有的 `signRs256` 就是同样的路子，照抄改算法即可
- 需要新增：订阅端点（存 endpoint + p256dh + auth）、Service Worker、控制台里的「订阅本设备」按钮
- 载荷加密走 RFC 8291 (aes128gcm)，这是本项里唯一的硬骨头

#### 7. Slack Bot / Discord Bot

现在只有 webhook。Bot token 能发线程消息、能读回复——**是第三梯队双向能力的前置条件**。

- Slack：`chat.postMessage`，Bot Token（`xoxb-`）
- Discord：`POST /channels/{id}/messages`，Bot Token

#### 8. 飞书应用 / 钉钉工作通知

现在两家都只有群机器人 webhook。企业内部应用消息能发给指定成员/部门，形态与目录里已有的 `wecom-app` 完全一致，可直接照着实现（`tenant_access_token` 缓存复用 `cachedToken()`）。

#### 9. AWS SES v2

目录里有 SNS 却没有 SES。SigV4 签名逻辑直接复用 `buildAwsSnsRequest()`，改 service 名与 endpoint 即可。

#### ⛔ 不要加 Opsgenie

已核实：Atlassian **2025-06-04 停售**，**2027-04-05 关停，届时 REST API 停止响应，未迁移数据全部删除**（来源：<https://www.atlassian.com/software/opsgenie/migration>）。目录里已有的 Jira Service Management 正是官方迁移目标，方向正确，不要回头加 Opsgenie。

### 第三梯队 · 双向能力（最能拉开与 A 类的差距）

#### 11. Telegram 内联按钮 + Webhook 回调

`ask_user` 的 `options` 直接渲染成 Telegram `inline_keyboard`，点一下即回，不用打开一次性链接。**这是 B 类竞品（ping-a-human / tasksync）的核心体验，我们目前唯一明显落后的地方。**

- 发送时带 `reply_markup.inline_keyboard`，`callback_data` 填 `conversationId:optionIndex`
- 新增 `POST /telegram/webhook/<secret>` 接收 `callback_query`，转成 `replyConversation()`
- 回调必须校验 `X-Telegram-Bot-Api-Secret-Token`
- 复用现有的一次性 token 语义：一个会话只接受第一次回复

#### 12. stdio MCP 包装

`npx walkie-mcp`——一个把 stdio JSON-RPC 转发到远端 `/mcp` 的瘦客户端。B 类竞品全是 stdio，零部署起步是它们唯一的结构性优势，抹平它成本很低。

#### 13. idle gating / 免打扰

已有 `quietHours`，再补一层「人正在键盘前就别推手机」：Agent 侧上报 idle 秒数，低于阈值时只走桌面/控制台，超过阈值才推手机。omni-notify-mcp 的主打卖点。

### 第四梯队 · 开发者体验

14. **`/openapi.json` + 在线文档页**——现在 REST API 只有 README 里的几段 curl
15. **GitHub Action / CLI**（`npx walkie send`）——CI 里最常见的用法
16. **英文 README**——目前全中文。发 GitHub 后这会挡掉相当一部分 star，建议 `README.md`（英文）+ `README.zh-CN.md`

---

## 五、建议的实施顺序

1. **第一梯队 1–3**（Slack + Discord + Alertmanager）——一天量，覆盖面最大，直接把「存量零改造迁移」讲成完整故事
2. **#16 英文 README**——发布前必做，成本最低
3. **第一梯队 4–5**（Pushover + Apprise）——补齐兼容矩阵
4. **#11 Telegram 内联按钮**——补上唯一明显的体验落差
5. **#6 Web Push**——补上「没有自有 App」的结构性短板
6. 其余按需

---

## 附：已核实的来源

- Pushover API：<https://pushover.net/api>
- Apprise API：<https://github.com/caronc/apprise-api>
- Gotify 鉴权（`X-Gotify-Key` / `?token=` / `Bearer`）：<https://github.com/gotify/server/blob/master/docs/spec.json>
- 企业微信 `enable_duplicate_check` 默认 0：<https://developer.work.weixin.qq.com/document/path/90236>
- Opsgenie 停售与关停时间线：<https://www.atlassian.com/software/opsgenie/migration>
- Deploy to Cloudflare 按钮：<https://developers.cloudflare.com/workers/platform/deploy-buttons/>
- Vercel Deploy Button（`env` / `envDescription` / `envLink` 参数）：<https://vercel.com/docs/deployments/deploy-button>
- Deploy to Render 按钮与 Blueprint：<https://render.com/docs/deploy-to-render>
