# MCP 配置工具 + Key 范围管理 设计文档

日期：2026-08-16
状态：待用户审阅

## 背景与目标

用户提出两个需求：

1. **Agent 自然语言配置**：MCP 连接后，用户直接对 AI 客户端（Claude Code / Codex / Cursor 等）说「我需要配置 Telegram，这是我的 Bot Token 和 Chat ID」，由 Agent 调用 MCP 工具完成渠道创建、路由编排、连通性测试。
2. **Key 可调用范围限制**：例如建 5 个 Telegram 渠道、开 5 个 key，每个 key 只能调用对应的那个渠道（只暴露那一个）。

## 现状盘点（探索结论）

- **需求 2 的执行端已存在**：`api_keys.destinationIds` 白名单（空 = 全部），发送时在 `NotificationService.resolveTarget`（`src/server/notifications.ts:11`）强制校验；创建 key 的 UI 已有「限制可用目的地」勾选（`src/web/components/Keys.tsx`）。
  **唯一缺口**：key 创建后无法编辑 scopes / 目的地（只有吊销/恢复/删除，无 PATCH 端点、无 `updateKey` 仓储方法、无编辑 UI）。
- **需求 1 是全新能力**：MCP（`src/server/mcp.ts`）目前只有发送类工具（`send_notification` / `ask_user` / `check_reply` / `get_delivery` / `list_destinations` / `list_routes`），无任何配置类工具。渠道/路由 CRUD 仅存在于 admin token 的 REST 接口（`/api/admin/*`）。
- 渠道 CRUD 的仓储方法、`validateProviderConfig` 必填校验、加密存储、软删除语义、审计事件均已完备，可直接复用。
- 35 个 provider 的字段目录（`src/server/providers/catalog.ts`）是结构化的（key/label/type/required/options/defaultValue），正是让 Agent 知道「该向用户要什么信息」的数据源。

## 方案选择

**需求 1（NL 配置）三个候选：**

- **A. 新增配置类 MCP 工具 + 新 scope（选定）**：新增 `config:write` scope，注册 `create_channel` / `test_channel` 等工具。自然语言理解由用户已接入的 AI 客户端完成，服务端只提供原子工具。零新增依赖，符合 MCP 生态惯例。
- B. 服务端单工具接收自然语言自行解析：需要在 Worker 里跑 LLM 或写脆弱的规则解析，成本高、不可靠。否决。
- C. 只做 admin REST、不做 MCP：不满足「对 Agent 说话即配置」的核心诉求。否决。

**需求 2（key 范围）两个候选：**

- **A. 补齐编辑能力（选定）**：加 `PATCH /api/admin/keys/:id` + `updateKey` + 编辑 UI，并顺带校验 destinationIds 有效性。执行端白名单已存在，这是最小闭环。
- B. 重新设计 per-channel ACL 表结构：现有 destinationIds 已覆盖「渠道或路由粒度」的需求场景，重设计属过度工程。否决。

## 功能一：MCP 配置工具

### 新 scope：`config:write`

- `src/shared/schemas.ts` 的 `keySchema.scopes` 枚举加入 `'config:write'`。
- 新 key 默认 scopes 仍为 `['notifications:send', 'deliveries:read']`，`config:write` 必须显式勾选。
- UI 标签：`配置管理`（Keys 页 SCOPE_OPTIONS、scope pills、卡片视图同步加映射）。
- **不设** `channels:write` / `routes:write` 细分——当前没有只给渠道不给路由的场景，YAGNI。

### 工具清单（9 个，全部 gated on `config:write`）

新文件 `src/server/mcp-config.ts`，导出 `registerConfigTools(server, repository, dispatcher, apiKey)`，由 `mcp.ts` 在 key 含 `config:write` 时调用。工具定义与 handler 全部集中在此文件，`mcp.ts` 只加一行注册。

| 工具 | 入参（要点） | 行为 |
|---|---|---|
| `list_channel_types` | `{}` | 返回 provider 目录（id/name/category/description/docsUrl/fields 含 required/options/defaultValue），Agent 据此向用户索取缺失字段 |
| `list_channels` | `{}` | 返回全部渠道（含禁用），即 Channel 对象（仅 configKeys，不含配置值） |
| `create_channel` | name/slug/provider/config，可选 enabled/rateLimitPerMin/quietHours | `validateProviderConfig` 必填校验后走 `repository.createChannel` |
| `update_channel` | channel（id 或 slug）+ 可选部分字段 | 与 admin PATCH 同语义：合并 config 后重新必填校验 |
| `delete_channel` | channel（id 或 slug） | 走既有软删除语义（被路由/投递引用时仅禁用），标注 `destructiveHint: true` |
| `test_channel` | channel（id 或 slug） | 发测试消息并更新 last_test_status，返回 success/error——NL 流程闭环的关键 |
| `create_route` | name/slug/strategy/channelIds | 校验渠道存在后创建 |
| `update_route` | route（id 或 slug）+ 部分字段 | 同 admin PATCH 语义 |
| `delete_route` | route（id 或 slug） | 走既有软删除语义 |

对既有工具的两处小调整（`mcp.ts`）：

- `list_routes`：key 含 `config:write` 时返回全部路由（含禁用、不受 destinationIds 过滤），否则维持现状。配置视角必须看全量。
- `instructions`：key 含 `config:write` 时追加一段：用户要求配置渠道时，先 `list_channel_types` 查字段定义 → 向用户询问缺失的必填值 → `create_channel` → `test_channel` → 向用户报告结果；绝不回显配置中的敏感值。

### 复用与防重复：共享校验助手

admin REST（`src/server/app.ts:97-148`）与 MCP 工具需要完全相同的校验逻辑（provider 存在性、必填字段、PATCH 合并后重校验、路由引用的渠道存在性）。提取到 `src/server/validation.ts`：

- `validateChannelCreate(input)` → 错误数组
- `validateChannelUpdate(repository, id, input)` → 错误数组（内部取当前渠道、合并 config、重校验）
- `assertRouteChannelIds(repository, channelIds)` → 错误数组

助手返回 `string[]`，REST 路由 `400 {error}`，MCP 工具 `throw new Error(join)`，两端行为一致。`app.ts` 的对应内联逻辑改调助手（纯等价重构）。

### 安全约束

1. **绝不暴露 key 管理**：配置工具不包含任何 key CRUD。`config:write` 若能创建 key 等于自我提权（agent 给自己发全 scope key），显式排除。
2. **绝不回显渠道配置值**：所有返回沿用 `Channel` 对象（仅 `configKeys`）。工具入参里的敏感值不回显、不写日志。
3. **审计**：仓储变更方法（`createChannel/updateChannel/deleteChannel/createRoute/updateRoute/deleteRoute`）增加可选尾参 `actor = 'admin'`；MCP 侧传 `agent:${apiKey.id}`，审计表可区分「人改的」还是「哪个 agent 改的」。现有调用点零改动。
4. **SSRF**：`test_channel` 经 `ProviderDispatcher` → `safeFetch`，沿用既有私网拦截，无新增网络面。
5. **destructive 工具**：`delete_channel` / `delete_route` 标注 `destructiveHint: true`，客户端会向用户二次确认。
6. **白名单语义**：`config:write` 与 `destinationIds` 正交——配置视角看全量渠道/路由（编排路由需要），发送仍受白名单约束。文档明确此点。

### 签名变更

`createRelayMcpServer(repository, notifications, apiKey, publicUrl)` → 增加 `dispatcher` 参数；`createRelayMcpHandler(repository, notifications, dispatcher, publicUrl)` 同步。两个调用点（`app.ts:51`、`src/worker/index.ts:83`）传入已有 dispatcher。

## 功能二：Key 范围编辑

### 后端

- `RelayRepository.updateKey(id, { name?, scopes?, destinationIds? })`：UPDATE 后返回完整 `ApiKey`，审计 `api_key.update`（details 记变更字段名列表）。
- `PATCH /api/admin/keys/:id`（`app.ts` + `src/worker/index.ts` 两处镜像路由）：新建 `keyUpdateSchema = keySchema.omit({ secret: true }).partial()`（**不允许编辑密钥本身**——改哈希等于换密钥，需换密钥走吊销重建）；`destinationIds` 逐项对照 `listDestinations()`，存在未知 ID 则 400「目的地不存在：…」。**create 端点同步加该校验**——静默存入失效 ID 正是现状隐患。
- scope 枚举扩展后，`keySchema` 自然接受 `config:write`，无需额外代码。

### 前端（Keys.tsx）

- `KeyForm` 增加 `editing?: ApiKey` 模式：预填 name/scopes/限制开关/目的地勾选，提交走 `api.updateKey`，无密钥展示屏；标题「编辑 Agent API Key」。
- 表格行与卡片视图加「编辑」按钮（有效 key 才显示）。
- `api.ts` 加 `updateKey(id, body)`。
- SCOPE_OPTIONS 增加 `{ id: 'config:write', label: '配置管理' }`；scope pills / 卡片权限文案加第三种映射（`配置`）。

## 典型数据流（需求 1 演示）

用户对 Claude Code 说：「帮我配一个 Telegram，token 是 xxx，chat id 是 yyy」

1. Agent 调 `list_channel_types` → 看到 telegram 需要 `botToken`（必填）、`chatId`（必填）等；
2. 用户已给齐 → `create_channel { name:'Telegram', slug:'telegram', provider:'telegram', config:{botToken:'xxx', chatId:'yyy'} }`；
3. `test_channel { channel:'telegram' }` → success；
4. Agent 回复「已配置并测试通过」。全程审计 actor 为 `agent:<keyId>`。

5 渠道 5 key 场景（需求 2）：admin 建 5 个 Telegram 渠道 → 开 5 个 key，每个勾选仅对应的 1 个目的地；日后渠道变化时直接在 Keys 页「编辑」调整，无需吊销重建。

## 测试计划

- **MCP 配置工具**（`tests/` 新增，沿用 `tests/app.test.ts` 的 supertest + JSON-RPC 模式）：
  - 无 `config:write` 的 key：`tools/list` 不含配置工具，直接调用报 Unknown tool；
  - 有 scope：`create_channel` 成功建 telegram 渠道；必填缺失返回明确错误；
  - `update_channel` 合并 config 后重校验；
  - `test_channel` 成功/失败两路（dispatcher fake fetch）；
  - **响应不含配置值**（沿用「不出现 hooks.example.com」断言模式）；
  - 审计行 actor = `agent:<keyId>`；
  - `delete_channel` 被路由引用时软禁用。
- **key 编辑**：
  - PATCH 改 scopes/destinationIds 生效（GET keys 验证）；
  - destinationIds 含未知 ID → 400；create 端点同样；
  - 改窄白名单后，发送到未授权目的地 → 403（沿用现有「API Key 无权访问该目的地」路径）。
- 全量 `npm test` + `npm run typecheck` 通过（三个 tsconfig 全检）。

## 明确不做（YAGNI）

- key 管理的 MCP 化（安全排除）；
- 条件表达式路由（现 fanout/fallback 已够，用户未提）；
- per-key 速率限制；
- `channels:write` / `routes:write` 细分 scope。

## 涉及文件清单

- `src/shared/schemas.ts`：scopes 枚举 + `config:write`
- `src/server/validation.ts`（新）：共享校验助手
- `src/server/mcp-config.ts`（新）：9 个配置工具
- `src/server/mcp.ts`：dispatcher 参数、注册配置工具、list_routes/instructions 调整
- `src/server/database.ts`：`updateKey`、6 个变更方法加 `actor` 尾参
- `src/server/app.ts` / `src/worker/index.ts`：PATCH keys 端点、校验助手替换、create key 目的地校验
- `src/web/components/Keys.tsx`、`src/web/api.ts`：编辑 UI + scope 选项
- `README.md`：`config:write` 说明与 MCP 配置流程示例
