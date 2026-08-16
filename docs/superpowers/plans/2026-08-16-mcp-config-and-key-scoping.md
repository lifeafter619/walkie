# MCP 配置工具 + Key 范围编辑 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Agent 通过 MCP 配置通知渠道/路由（9 个新工具，`config:write` scope），并补齐 Key 范围编辑（PATCH 端点 + 编辑 UI）。

**Architecture:** 复用现有仓储层（加密存储/软删除/审计已完备）。新增 `src/server/validation.ts` 统一 admin REST 与 MCP 工具的校验；新增 `src/server/mcp-config.ts` 集中 9 个配置工具；MCP handler 签名加 `dispatcher` 参数（`test_channel` 用）。Key 侧补 `updateKey` + PATCH 端点（Node/Worker 双端）+ 编辑 UI。

**Tech Stack:** TypeScript (ESM)、Express 5、Cloudflare Worker（镜像路由）、zod、@modelcontextprotocol/server v2、React 19 SPA、better-sqlite3、vitest + supertest。

**设计文档:** `docs/superpowers/specs/2026-08-16-mcp-config-and-key-scoping-design.md`

## Global Constraints

- 用户可见文案为中文（错误消息、UI 标签、README）。
- 三个运行时行为一致：`src/server/app.ts` 与 `src/worker/index.ts` 的路由改动必须镜像。
- 敏感值（渠道配置值、密钥）绝不出现在 API/MCP 响应中；渠道响应用 `Channel` 对象（仅 `configKeys`）。
- 破坏性 MCP 工具（delete_channel/delete_route）标注 `destructiveHint: true`。
- `config:write` 不含任何 key 管理能力。
- 每 task 结束 `npm run typecheck` + 相关测试全绿才 commit；commit 消息中文（`feat(scope): …` 风格）。
- 测试命令：`npx vitest run tests/<file>`；全量 `npm test`。
- 仓库路径 `D:\Project\relaydock`，Git Bash on Windows。
- MCP stateless 模式：`tools/list`、`tools/call` 可直接 POST `/mcp` 调用，无需先 initialize（见 tests/app.test.ts 既有模式）。请求头需 `Authorization: Bearer <secret>` 与 `Accept: application/json, text/event-stream`。
- Express 全局错误中间件（app.ts:283-289）按消息映射状态码：含 `not found|不存在` → 404，`UNIQUE constraint failed` → 409，其余 400。Worker 同规则（worker/index.ts:205-212）。仓储方法抛 `Error('Key not found')` / `Error('Channel not found')` 即自动 404。

---

### Task 1: `config:write` scope 枚举 + 共享校验助手 `validation.ts`

**Files:**
- Modify: `src/shared/schemas.ts`
- Create: `src/server/validation.ts`
- Test: `tests/validation.test.ts`

**Interfaces:**
- Consumes: `channelSchema`/`keySchema`（schemas.ts）；`RelayRepository.getChannel/getChannelConfig/listChannels/listDestinations`；`PROVIDER_MAP`/`validateProviderConfig`（providers/catalog.ts）。
- Produces（后续 task 依赖的精确签名）:
  - `SCOPE_IDS: readonly ['notifications:send', 'deliveries:read', 'config:write']`（schemas.ts 导出）
  - `keyUpdateSchema`（schemas.ts 导出，Task 3 用）
  - `validateChannelCreate(provider: unknown, config: Record<string, unknown>): string[]`
  - `validateChannelUpdate(repository, id: string, input: { provider?: unknown; config?: Record<string, unknown> }): Promise<{ current?: Channel; errors: string[] }>`
  - `validateRouteChannelIds(repository, channelIds: string[]): Promise<string[]>`
  - `assertKeyDestinations(repository, destinationIds: string[]): Promise<string[]>`

- [ ] **Step 1: 写失败测试 `tests/validation.test.ts`**

```typescript
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createNodeRepository } from '../src/server/database-node.js';
import { validateChannelCreate, validateChannelUpdate, validateRouteChannelIds, assertKeyDestinations } from '../src/server/validation.js';

const createRepository = () => createNodeRepository(':memory:', randomBytes(32));

describe('validation helpers', () => {
  it('validateChannelCreate rejects unknown provider and missing required fields', () => {
    expect(validateChannelCreate('no-such-provider', {})).toEqual(['不支持的渠道类型']);
    expect(validateChannelCreate('telegram', {})).toEqual(['Bot Token不能为空', 'Chat ID不能为空']);
    expect(validateChannelCreate('telegram', { botToken: 't', chatId: '42' })).toEqual([]);
  });

  it('validateChannelUpdate merges config then revalidates required fields', async () => {
    const repository = await createRepository();
    await repository.createChannel({ name: 'Ops', slug: 'ops', provider: 'telegram', config: { botToken: 't', chatId: '42' } });
    const rename = await validateChannelUpdate(repository, 'ops', { name: 'New' });
    expect(rename.errors).toEqual([]);
    expect(rename.current?.name).toBe('Ops');
    const broken = await validateChannelUpdate(repository, 'ops', { config: { botToken: '' } });
    expect(broken.errors).toContain('Bot Token不能为空');
    const switchProvider = await validateChannelUpdate(repository, 'ops', { provider: 'slack', config: {} });
    expect(switchProvider.errors).toEqual(['Webhook 地址不能为空']);
    repository.close();
  });

  it('validateRouteChannelIds flags unknown channel ids', async () => {
    const repository = await createRepository();
    const channel = await repository.createChannel({ name: 'Ops', slug: 'ops', provider: 'telegram', config: { botToken: 't', chatId: '42' } });
    expect(await validateRouteChannelIds(repository, [channel.id])).toEqual([]);
    expect(await validateRouteChannelIds(repository, [channel.id, 'no-such-id'])).toEqual(['路由包含不存在的频道']);
    repository.close();
  });

  it('assertKeyDestinations flags unknown destination ids', async () => {
    const repository = await createRepository();
    const channel = await repository.createChannel({ name: 'Ops', slug: 'ops', provider: 'telegram', config: { botToken: 't', chatId: '42' } });
    expect(await assertKeyDestinations(repository, [channel.id])).toEqual([]);
    expect(await assertKeyDestinations(repository, ['no-such-dest'])).toEqual(['目的地不存在：no-such-dest']);
    repository.close();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/validation.test.ts`
Expected: FAIL — 找不到模块 `../src/server/validation.js`

- [ ] **Step 3: 修改 `src/shared/schemas.ts`**

在 `keySchema` 前加导出，并改 `scopes` 字段与新增 `keyUpdateSchema`：

```typescript
export const SCOPE_IDS = ['notifications:send', 'deliveries:read', 'config:write'] as const;

export const keySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(SCOPE_IDS)).min(1).optional(),
  destinationIds: z.array(z.string()).optional(),
  /** 自定义密钥（像密码一样随意设置）；缺省则服务端生成随机 rdk_ 密钥 */
  secret: secretSchema.optional()
});

/** 编辑 Key：不允许改密钥本身（换密钥走吊销重建）；strict 拒绝未知键 */
export const keyUpdateSchema = keySchema.omit({ secret: true }).strict();
```

- [ ] **Step 4: 创建 `src/server/validation.ts`**

```typescript
import type { Channel, ProviderId } from '../shared/types.js';
import type { RelayRepository } from './database.js';
import { PROVIDER_MAP, validateProviderConfig } from './providers/catalog.js';

/** 创建频道校验：provider 存在 + 必填字段（admin REST 与 MCP create_channel 共用） */
export function validateChannelCreate(provider: unknown, config: Record<string, unknown>): string[] {
  if (!PROVIDER_MAP.has(provider as ProviderId)) return ['不支持的渠道类型'];
  return validateProviderConfig(provider as ProviderId, config);
}

/**
 * 更新频道校验：换 provider/改 config 时合并当前配置后重校验必填字段。
 * 返回解析出的当前频道（slug 入参也能解析），供调用方写回真实 id。
 */
export async function validateChannelUpdate(repository: RelayRepository, id: string, input: { provider?: unknown; config?: Record<string, unknown> }): Promise<{ current?: Channel; errors: string[] }> {
  const current = await repository.getChannel(id);
  if (!current) return { errors: ['频道不存在'] };
  if (!input.config && !input.provider) return { current, errors: [] };
  const providerToCheck = (input.provider ?? current.provider) as ProviderId;
  if (!PROVIDER_MAP.has(providerToCheck)) return { current, errors: ['不支持的渠道类型'] };
  const merged = { ...await repository.getChannelConfig(current.id), ...(input.config ?? {}) };
  return { current, errors: validateProviderConfig(providerToCheck, merged) };
}

/** 路由引用频道校验（admin REST 与 MCP create_route/update_route 共用） */
export async function validateRouteChannelIds(repository: RelayRepository, channelIds: string[]): Promise<string[]> {
  const channels = new Set((await repository.listChannels()).map((channel) => channel.id));
  return channelIds.some((id) => !channels.has(id)) ? ['路由包含不存在的频道'] : [];
}

/** Key 目的地白名单校验（admin REST create/patch key 共用），未知 ID 全部列出 */
export async function assertKeyDestinations(repository: RelayRepository, destinationIds: string[]): Promise<string[]> {
  if (!destinationIds.length) return [];
  const destinations = new Set((await repository.listDestinations()).map((destination) => destination.id));
  const unknown = destinationIds.filter((id) => !destinations.has(id));
  return unknown.length ? [`目的地不存在：${unknown.join('、')}`] : [];
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/validation.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: typecheck + commit**

Run: `npm run typecheck` — 无错误

```bash
git add src/shared/schemas.ts src/server/validation.ts tests/validation.test.ts
git commit -m "feat(scope): 新增 config:write 权限与共享校验助手"
```

---

### Task 2: 仓储层 `updateKey` + 变更方法加 `actor` 尾参 + `listAuditEvents`

**Files:**
- Modify: `src/server/database.ts`
- Test: `tests/repository.test.ts`（追加用例）

**Interfaces:**
- Produces:
  - `async updateKey(id: string, input: { name?: string; scopes?: string[]; destinationIds?: string[] }): Promise<ApiKey>` — 不存在抛 `Error('Key not found')`；审计 `api_key.update`，details `{ fields: string[] }`（按入参出现的键）。
  - `async listAuditEvents(limit = 100)` — 返回倒序审计数组 `{ id, actor, action, resourceType, resourceId?, details, createdAt }`。
  - `createChannel(input, actor = 'admin')`、`updateChannel(id, input, actor = 'admin')`、`deleteChannel(id, actor = 'admin')`、`createRoute(input, actor = 'admin')`、`updateRoute(id, input, actor = 'admin')`、`deleteRoute(id, actor = 'admin')` — 内部 audit 调用把 `'admin'` 换成 `actor`。可选尾参，既有调用点零改动。

- [ ] **Step 1: 写失败测试（追加到 tests/repository.test.ts 的 describe 内）**

```typescript
  it('updates key scopes and destinations with audit trail', async () => {
    const repository = await createRepository();
    const channel = await repository.createChannel({ name: 'Ops', slug: 'ops', provider: 'telegram', config: { botToken: 't', chatId: '42' } });
    const { apiKey } = await repository.createKey({ name: 'Editor' });
    const updated = await repository.updateKey(apiKey.id, { scopes: ['config:write'], destinationIds: [channel.id] });
    expect(updated.scopes).toEqual(['config:write']);
    expect(updated.destinationIds).toEqual([channel.id]);
    expect((await repository.getKey(apiKey.id))?.scopes).toEqual(['config:write']);
    await expect(repository.updateKey('no-such-key', { name: 'x' })).rejects.toThrow('Key not found');
    const keyUpdate = (await repository.listAuditEvents()).find((event) => event.action === 'api_key.update');
    expect(keyUpdate?.actor).toBe('admin');
    expect(keyUpdate?.details).toEqual({ fields: ['scopes', 'destinationIds'] });
    repository.close();
  });

  it('records agent actor on channel mutations', async () => {
    const repository = await createRepository();
    await repository.createChannel({ name: 'Ops', slug: 'ops', provider: 'telegram', config: { botToken: 't', chatId: '42' } }, 'agent:key-1');
    expect((await repository.listAuditEvents()).find((event) => event.action === 'channel.create')?.actor).toBe('agent:key-1');
    repository.close();
  });
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/repository.test.ts`
Expected: FAIL — `repository.updateKey is not a function`

- [ ] **Step 3: 实现（src/server/database.ts）**

1. 六个方法签名加 `actor = 'admin'` 尾参，方法体内 `this.audit('admin', …)` 改为 `this.audit(actor, …)`。涉及行（当前行号）：`createChannel` 242、`updateChannel` 263、`deleteChannel` 286、`createRoute` 319、`updateRoute` 331、`deleteRoute` 343 与 347（route.disable 与 route.delete 两处）。

2. `updateKey`（放在 `restoreKey` 之后）：

```typescript
  /** 编辑 Key 的名称/scope/目的地白名单；不改动密钥本身（换密钥走吊销重建） */
  async updateKey(id: string, input: { name?: string; scopes?: string[]; destinationIds?: string[] }): Promise<ApiKey> {
    const COLUMNS = { name: 'name', scopes: 'scopes', destinationIds: 'destination_ids' } as const;
    const fields = (Object.keys(COLUMNS) as Array<keyof typeof COLUMNS>).filter((field) => input[field] !== undefined);
    const existing = await this.getKey(id);
    if (!existing) throw new Error('Key not found');
    if (fields.length) {
      const params = fields.map((field) => field === 'name' ? input.name! : JSON.stringify(input[field]));
      await this.db.run(`UPDATE api_keys SET ${fields.map((field) => `${COLUMNS[field]}=?`).join(', ')} WHERE id=?`, [...params, id]);
      await this.audit('admin', 'api_key.update', 'api_key', id, { fields });
    }
    return (await this.getKey(id))!;
  }
```

3. `listAuditEvents`（放在 `audit` 方法之前）：

```typescript
  async listAuditEvents(limit = 100): Promise<Array<{ id: string; actor: string; action: string; resourceType: string; resourceId?: string; details: Record<string, unknown>; createdAt: string }>> {
    const rows = await this.db.all('SELECT * FROM audit_events ORDER BY created_at DESC LIMIT ?', [limit]);
    return rows.map((row) => ({
      id: String(row.id), actor: String(row.actor), action: String(row.action), resourceType: String(row.resource_type),
      resourceId: row.resource_id ? String(row.resource_id) : undefined,
      details: row.details ? JSON.parse(String(row.details)) : {}, createdAt: String(row.created_at)
    }));
  }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/repository.test.ts` — PASS（含既有用例）

- [ ] **Step 5: typecheck + commit**

Run: `npm run typecheck` — 无错误

```bash
git add src/server/database.ts tests/repository.test.ts
git commit -m "feat(keys): updateKey 编辑方法、审计 actor 透传与审计查询"
```

---

### Task 3: admin REST — PATCH key 端点 + 校验助手替换（Node + Worker 双端）

**Files:**
- Modify: `src/server/app.ts`（channels/routes/keys 路由段，约 97-157 行）
- Modify: `src/worker/index.ts`（channels/routes/keys 段，约 221-283 行）
- Test: `tests/app.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 1 `keyUpdateSchema`/`assertKeyDestinations`/三个校验助手；Task 2 `updateKey`。
- Produces: `PATCH /api/admin/keys/:id`（200 + ApiKey；不存在 404；未知目的地/未知键 400）。create key 加目的地校验。channels/routes 内联校验替换为助手（行为等价）。

- [ ] **Step 1: 写失败测试（tests/app.test.ts 文件末尾追加）**

```typescript
describe('admin key editing', () => {
  it('updates scopes and destination whitelist via PATCH', async () => {
    const { app, repository } = await setup();
    const channel = await repository.createChannel({ name: 'Ops', slug: 'ops', provider: 'webhook', config: { url: 'https://hooks.example.com/x', method: 'POST', bodyTemplate: '{}' } });
    const created = await request(app).post('/api/admin/keys').send({ name: 'Editable' }).expect(201);
    const id = created.body.apiKey.id as string;

    await request(app).patch(`/api/admin/keys/${id}`).send({ scopes: ['notifications:send', 'config:write'], destinationIds: [channel.id] }).expect(200);
    const listed = await request(app).get('/api/admin/keys').expect(200);
    const key = listed.body.keys.find((item: { id: string }) => item.id === id);
    expect(key.scopes).toEqual(['notifications:send', 'config:write']);
    expect(key.destinationIds).toEqual([channel.id]);

    await request(app).patch(`/api/admin/keys/${id}`).send({ destinationIds: ['no-such-dest'] }).expect(400);
    await request(app).patch('/api/admin/keys/no-such-key').send({ name: 'x' }).expect(404);
  });

  it('rejects unknown destinations on key create', async () => {
    const { app } = await setup();
    await request(app).post('/api/admin/keys').send({ name: 'Bad', destinationIds: ['no-such-dest'] }).expect(400);
  });

  it('rejects secret or unknown fields via PATCH', async () => {
    const { app } = await setup();
    const created = await request(app).post('/api/admin/keys').send({ name: 'S' }).expect(201);
    await request(app).patch(`/api/admin/keys/${created.body.apiKey.id}`).send({ secret: 'new-secret-123' }).expect(400);
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/app.test.ts -t 'admin key editing'`
Expected: FAIL — PATCH 404（路由不存在）

- [ ] **Step 3: 实现 Node 端（src/server/app.ts）**

1. import 调整：`./validation.js` 引入 `assertKeyDestinations, validateChannelCreate, validateChannelUpdate, validateRouteChannelIds`；`../shared/schemas.js` 的既有 import 增加 `keyUpdateSchema`；可删除不再使用的 `PROVIDER_MAP`/`validateProviderConfig` import。

2. keys 路由段替换为：

```typescript
  admin.get('/keys', asyncRoute(async (_req, res) => res.json({ keys: await repository.listKeys() })));
  admin.post('/keys', asyncRoute(async (req, res) => {
    const input = keySchema.parse(req.body);
    if (input.destinationIds?.length) {
      const errors = await assertKeyDestinations(repository, input.destinationIds);
      if (errors.length) return res.status(400).json({ error: errors.join('；') });
    }
    res.status(201).json(await repository.createKey(input));
  }));
  admin.patch('/keys/:id', asyncRoute(async (req, res) => {
    const input = keyUpdateSchema.parse(req.body);
    if (input.destinationIds) {
      const errors = await assertKeyDestinations(repository, input.destinationIds);
      if (errors.length) return res.status(400).json({ error: errors.join('；') });
    }
    res.json(await repository.updateKey(String(req.params.id), input));
  }));
  admin.post('/keys/:id/revoke', …既有不变…);
  admin.post('/keys/:id/restore', …既有不变…);
  admin.delete('/keys/:id', …既有不变…);
```

（`updateKey` 抛 `Key not found` → 全局中间件 404。）

3. channels 路由段替换（POST 用 create 校验；PATCH 保持「仅 config/provider 变化才校验」的原条件结构）：

```typescript
  admin.post('/channels', asyncRoute(async (req, res) => {
    const input = channelSchema.parse(req.body);
    const errors = validateChannelCreate(input.provider, input.config);
    if (errors.length) return res.status(400).json({ error: errors.join('；') });
    res.status(201).json(await repository.createChannel({ ...input, provider: input.provider as ProviderId }));
  }));
  admin.patch('/channels/:id', asyncRoute(async (req, res) => {
    const input = channelSchema.partial().parse(req.body);
    if (input.config || input.provider) {
      const { current, errors } = await validateChannelUpdate(repository, String(req.params.id), input);
      if (errors[0] === '频道不存在') return res.status(404).json({ error: '频道不存在' });
      if (errors.length) return res.status(400).json({ error: errors.join('；') });
      res.json(await repository.updateChannel(current!.id, { ...input, provider: input.provider as ProviderId | undefined }));
      return;
    }
    res.json(await repository.updateChannel(String(req.params.id), { ...input, provider: input.provider as ProviderId | undefined }));
  }));
```

（与原实现差异：原版 PATCH 换 provider 时先 `PROVIDER_MAP.has` 检查 throw 400，此处由 helper 返回 `['不支持的渠道类型']` → 400，行为一致。）

4. routes 路由段替换：

```typescript
  admin.post('/routes', asyncRoute(async (req, res) => {
    const input = routeSchema.parse(req.body);
    const errors = await validateRouteChannelIds(repository, input.channelIds);
    if (errors.length) return res.status(400).json({ error: errors.join('；') });
    res.status(201).json(await repository.createRoute(input));
  }));
  admin.patch('/routes/:id', asyncRoute(async (req, res) => {
    const input = routeSchema.partial().parse(req.body);
    if (input.channelIds) {
      const errors = await validateRouteChannelIds(repository, input.channelIds);
      if (errors.length) return res.status(400).json({ error: errors.join('；') });
    }
    res.json(await repository.updateRoute(String(req.params.id), input));
  }));
```

- [ ] **Step 4: 实现 Worker 端镜像（src/worker/index.ts）**

同构逻辑，if-chain 风格。import 增加 `keyUpdateSchema`（schemas.js）与四个校验助手（validation.js）。

1. channels POST/PATCH 分支替换为（照 app.ts 语义）：

```typescript
    if (path === '/api/admin/channels' && request.method === 'POST') {
      const input = channelSchema.parse(await readBody(request));
      const errors = validateChannelCreate(input.provider, input.config);
      if (errors.length) return json({ error: errors.join('；') }, 400);
      return json(await this.repository.createChannel({ ...input, provider: input.provider as ProviderId }), 201);
    }
    const channel = /^\/api\/admin\/channels\/([^/]+)$/.exec(path);
    if (channel && request.method === 'PATCH') {
      const input = channelSchema.partial().parse(await readBody(request));
      if (input.config || input.provider) {
        const { current, errors } = await validateChannelUpdate(this.repository, channel[1], input);
        if (errors[0] === '频道不存在') return json({ error: '频道不存在' }, 404);
        if (errors.length) return json({ error: errors.join('；') }, 400);
        return json(await this.repository.updateChannel(current!.id, { ...input, provider: input.provider as ProviderId | undefined }));
      }
      return json(await this.repository.updateChannel(channel[1], { ...input, provider: input.provider as ProviderId | undefined }));
    }
```

2. routes POST/PATCH 分支替换为 `validateRouteChannelIds` 等价结构（照 app.ts Step 3.4）。

3. keys 段：POST 加目的地校验；在 `restore` 分支后、`deleteKey` 正则之前插入 PATCH 分支（与 DELETE 共用同一路径正则，按 method 区分）：

```typescript
    const patchKey = /^\/api\/admin\/keys\/([^/]+)$/.exec(path);
    if (patchKey && request.method === 'PATCH') {
      const input = keyUpdateSchema.parse(await readBody(request));
      if (input.destinationIds) {
        const errors = await assertKeyDestinations(this.repository, input.destinationIds);
        if (errors.length) return json({ error: errors.join('；') }, 400);
      }
      return json(await this.repository.updateKey(patchKey[1], input));
    }
```

（POST keys 分支同步加 `assertKeyDestinations`，与 app.ts 相同。）

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/app.test.ts` — PASS（含既有用例）

- [ ] **Step 6: 全量回归 + typecheck + commit**

Run: `npm test && npm run typecheck` — 全绿

```bash
git add src/server/app.ts src/worker/index.ts tests/app.test.ts
git commit -m "feat(keys): PATCH 编辑端点与目的地校验，双端镜像"
```

---

### Task 4: `mcp-config.ts` — 9 个配置工具 + mcp.ts 接线

**Files:**
- Create: `src/server/mcp-config.ts`
- Modify: `src/server/mcp.ts`
- Modify: `src/server/app.ts:51`、`src/worker/index.ts:83`（handler 调用点传 dispatcher）
- Test: `tests/mcp-config.test.ts`

**Interfaces:**
- Consumes: Task 1 校验助手；Task 2 `actor` 尾参；`PROVIDERS`（catalog.ts）；`ProviderDispatcher.send(provider, config, message)`。
- Produces:
  - `export function registerConfigTools(server: McpServer, repository: RelayRepository, dispatcher: ProviderDispatcher, apiKey: ApiKey): void`
  - `createRelayMcpServer(repository, notifications, dispatcher, apiKey, publicUrl)` 新签名（dispatcher 第三参）
  - `createRelayMcpHandler(repository, notifications, dispatcher, publicUrl)` 新签名
  - 9 个工具名：`list_channel_types` `list_channels` `create_channel` `update_channel` `delete_channel` `test_channel` `create_route` `update_route` `delete_route`

- [ ] **Step 1: 写失败测试 `tests/mcp-config.test.ts`**

```typescript
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { AppConfig } from '../src/server/config.js';
import { createApp } from '../src/server/app.js';
import type { RelayRepository } from '../src/server/database.js';
import { createNodeRepository } from '../src/server/database-node.js';
import { NotificationService } from '../src/server/notifications.js';
import { ProviderDispatcher } from '../src/server/providers/dispatcher.js';
import { DeliveryWorker } from '../src/server/queue.js';

const repositories: RelayRepository[] = [];
afterEach(() => repositories.splice(0).forEach((repository) => repository.close()));

async function setup() {
  const config = {
    port: 4310, host: '127.0.0.1', dataDir: '.', databasePath: ':memory:', adminToken: undefined,
    masterKey: randomBytes(32), allowPrivateWebhooks: true, allowInsecureHttp: false,
    deliveryWorkers: 1, maxSendsPerMin: 0, maxDeliveryAttempts: 1, retryBaseMs: 1, isProduction: false
  } as AppConfig;
  const repository = await createNodeRepository(':memory:', config.masterKey); repositories.push(repository);
  const notifications = new NotificationService(repository);
  const dispatcher = new ProviderDispatcher(config, async () => new Response('{}', { status: 200 }));
  const worker = new DeliveryWorker(repository, dispatcher, config);
  const app = createApp({ config, repository, notifications, dispatcher, worker });
  const { secret } = await repository.createKey({ name: 'config-agent', scopes: ['config:write', 'notifications:send'] });
  const plain = await repository.createKey({ name: 'plain-agent', scopes: ['notifications:send'] });
  return { app, repository, secret, plainSecret: plain.secret };
}

const call = (app: ReturnType<typeof createApp>, secret: string, id: number, name: string, args: Record<string, unknown> = {}) =>
  request(app).post('/mcp')
    .set('Authorization', `Bearer ${secret}`)
    .set('Accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

describe('MCP config tools', () => {
  it('hides config tools from keys without config:write', async () => {
    const { app, plainSecret } = await setup();
    const tools = await request(app).post('/mcp')
      .set('Authorization', `Bearer ${plainSecret}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
      .expect(200);
    expect(tools.text).not.toContain('create_channel');
    const denied = await call(app, plainSecret, 2, 'create_channel', { name: 'X', slug: 'x', provider: 'telegram', config: { botToken: 't', chatId: '1' } });
    expect(denied.body.error).toBeTruthy();
  });

  it('lists channel types with field definitions', async () => {
    const { app, secret } = await setup();
    const res = await call(app, secret, 1, 'list_channel_types').expect(200);
    expect(res.text).toContain('telegram');
    expect(res.text).toContain('botToken');
    expect(res.text).toContain('required');
  });

  it('creates, updates and tests a channel; never echoes config values', async () => {
    const { app, repository, secret } = await setup();
    const created = await call(app, secret, 1, 'create_channel', { name: 'My Telegram', slug: 'my-tg', provider: 'telegram', config: { botToken: 'super-secret-token', chatId: '42' } }).expect(200);
    expect(created.text).toContain('my-tg');
    expect(created.text).not.toContain('super-secret-token');
    const channel = await repository.getChannel('my-tg');
    expect(channel?.provider).toBe('telegram');

    await call(app, secret, 2, 'update_channel', { channel: 'my-tg', name: 'Renamed' }).expect(200);
    expect((await repository.getChannel('my-tg'))?.name).toBe('Renamed');
    // 改 config 缺必填 → 报错
    const broken = await call(app, secret, 3, 'update_channel', { channel: 'my-tg', config: { botToken: '' } });
    expect(JSON.stringify(broken.body)).toContain('Bot Token不能为空');

    const tested = await call(app, secret, 4, 'test_channel', { channel: 'my-tg' }).expect(200);
    expect(tested.text).toContain('"success":true');
    expect((await repository.getChannel('my-tg'))?.lastTestStatus).toBe('success');

    const events = await repository.listAuditEvents();
    const createEvent = events.find((event) => event.action === 'channel.create');
    expect(createEvent?.actor).toMatch(/^agent:/);
    expect((await repository.getKey(createEvent!.resourceId!))?.id).toBe(createEvent!.resourceId);
  });

  it('create_channel missing required fields returns joined errors', async () => {
    const { app, secret } = await setup();
    const res = await call(app, secret, 1, 'create_channel', { name: 'X', slug: 'x', provider: 'telegram', config: {} });
    expect(JSON.stringify(res.body)).toContain('Bot Token不能为空');
    expect(JSON.stringify(res.body)).toContain('Chat ID不能为空');
  });

  it('manages routes: create, update, delete', async () => {
    const { app, repository, secret } = await setup();
    const channel = await repository.createChannel({ name: 'Ops', slug: 'ops', provider: 'telegram', config: { botToken: 't', chatId: '42' } });
    await call(app, secret, 1, 'create_route', { name: 'All', slug: 'all', strategy: 'fanout', channelIds: [channel.id] }).expect(200);
    expect(await repository.getRoute('all')).toBeTruthy();
    await call(app, secret, 2, 'update_route', { route: 'all', name: 'Renamed' }).expect(200);
    expect((await repository.getRoute('all'))?.name).toBe('Renamed');
    const bad = await call(app, secret, 3, 'create_route', { name: 'Bad', slug: 'bad', strategy: 'fanout', channelIds: ['no-such'] });
    expect(JSON.stringify(bad.body)).toContain('路由包含不存在的频道');
    await call(app, secret, 4, 'delete_route', { route: 'all' }).expect(200);
    expect(await repository.getRoute('all')).toBeUndefined();
  });

  it('delete_channel soft-disables when referenced by a route', async () => {
    const { app, repository, secret } = await setup();
    const channel = await repository.createChannel({ name: 'Ops', slug: 'ops', provider: 'telegram', config: { botToken: 't', chatId: '42' } });
    await repository.createRoute({ name: 'R', slug: 'r', strategy: 'fanout', channelIds: [channel.id] });
    await call(app, secret, 1, 'delete_channel', { channel: 'ops' }).expect(200);
    expect((await repository.getChannel(channel.id))?.enabled).toBe(false);
  });
});
```

（第三个用例最后一段 audit actor 断言已直接写为干净版本：actor 匹配 `^agent:`，且 resourceId 能反查回对应 key。）

- [ ] **Step 2: 运行确认失败**

Run: `npx vitest run tests/mcp-config.test.ts`
Expected: FAIL — `create_channel` Unknown tool / tools/list 不含

- [ ] **Step 3: 创建 `src/server/mcp-config.ts`**

```typescript
import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ApiKey, ProviderId } from '../shared/types.js';
import type { RelayRepository } from './database.js';
import type { ProviderDispatcher } from './providers/dispatcher.js';
import { PROVIDERS } from './providers/catalog.js';
import { validateChannelCreate, validateChannelUpdate, validateRouteChannelIds } from './validation.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

const refSchema = z.string().min(1).describe('Channel or route ID or slug');
const testMessage = { title: 'Walkie 测试通知', body: '频道连接正常，可以接收 Agent 通知。', severity: 'success' as const, metadata: {} };

/** config:write 工具集：渠道与路由的查看/创建/更新/删除/测试。不包含任何 Key 管理能力。 */
export function registerConfigTools(server: McpServer, repository: RelayRepository, dispatcher: ProviderDispatcher, apiKey: ApiKey): void {
  const actor = `agent:${apiKey.id}`;
  const throwErrors = (errors: string[]) => { if (errors.length) throw new Error(errors.join('；')); };

  server.registerTool('list_channel_types', {
    title: 'List channel types',
    description: 'List all supported channel types with their config field definitions (labels, required flags, options). Use this to learn which values to ask the user for before create_channel.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true }
  }, async () => result({ channelTypes: PROVIDERS }));

  server.registerTool('list_channels', {
    title: 'List channels',
    description: 'List all channels (including disabled) with provider, slug and config key names. Config values are never returned.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true }
  }, async () => result({ channels: await repository.listChannels() }));

  server.registerTool('create_channel', {
    title: 'Create a channel',
    description: 'Create a notification channel. Call list_channel_types first for required fields of the provider.',
    inputSchema: z.object({
      name: z.string().min(1).max(100),
      slug: z.string().min(2).max(80).regex(/^[a-z0-9][a-z0-9-]*$/),
      provider: z.string().min(1),
      config: z.record(z.string(), z.unknown()),
      enabled: z.boolean().optional(),
      rateLimitPerMin: z.number().int().min(0).max(600).nullish(),
      quietHours: z.string().max(40).nullish()
    }),
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async (input) => {
    throwErrors(validateChannelCreate(input.provider, input.config));
    const channel = await repository.createChannel({ ...input, provider: input.provider as ProviderId }, actor);
    return result({ channel });
  });

  server.registerTool('update_channel', {
    title: 'Update a channel',
    description: 'Update an existing channel by ID or slug. Config merges over the stored values; required fields are revalidated after merge.',
    inputSchema: z.object({
      channel: refSchema,
      name: z.string().min(1).max(100).optional(),
      slug: z.string().min(2).max(80).regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
      provider: z.string().min(1).optional(),
      config: z.record(z.string(), z.unknown()).optional(),
      enabled: z.boolean().optional(),
      rateLimitPerMin: z.number().int().min(0).max(600).nullish(),
      quietHours: z.string().max(40).nullish()
    }),
    annotations: { destructiveHint: false, openWorldHint: false }
  }, async ({ channel: ref, provider, config, ...rest }) => {
    const { current, errors } = await validateChannelUpdate(repository, ref, { provider, config });
    if (!current) throw new Error('频道不存在');
    throwErrors(errors);
    const updated = await repository.updateChannel(current.id, { ...rest, ...(provider ? { provider: provider as ProviderId } : {}), ...(config ? { config } : {}) }, actor);
    return result({ channel: updated });
  });

  server.registerTool('delete_channel', {
    title: 'Delete a channel',
    description: 'Delete a channel by ID or slug. If referenced by routes or past deliveries it is disabled instead of removed.',
    inputSchema: z.object({ channel: refSchema }),
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ channel: ref }) => {
    const current = await repository.getChannel(ref);
    if (!current) throw new Error('频道不存在');
    await repository.deleteChannel(current.id, actor);
    return result({ deleted: true, id: current.id, slug: current.slug });
  });

  server.registerTool('test_channel', {
    title: 'Test a channel',
    description: 'Send a test notification through a channel and report success or the provider error. Use after create/update to verify credentials.',
    inputSchema: z.object({ channel: refSchema }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  }, async ({ channel: ref }) => {
    const channel = await repository.getChannel(ref);
    if (!channel) throw new Error('频道不存在');
    try {
      await dispatcher.send(channel.provider, await repository.getChannelConfig(channel.id), { ...testMessage });
      await repository.setChannelTest(channel.id, true);
      return result({ success: true, channel: channel.slug });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await repository.setChannelTest(channel.id, false, message);
      return result({ success: false, error: message, channel: channel.slug });
    }
  });

  server.registerTool('create_route', {
    title: 'Create a route',
    description: 'Create a route (fanout sends to all channels; fallback tries channels in order until one succeeds).',
    inputSchema: z.object({
      name: z.string().min(1).max(100),
      slug: z.string().min(2).max(80).regex(/^[a-z0-9][a-z0-9-]*$/),
      strategy: z.enum(['fanout', 'fallback']),
      channelIds: z.array(z.string().min(1)).min(1),
      enabled: z.boolean().optional()
    }),
    annotations: { destructiveHint: false, openWorldHint: false }
  }, async (input) => {
    throwErrors(await validateRouteChannelIds(repository, input.channelIds));
    const route = await repository.createRoute(input, actor);
    return result({ route });
  });

  server.registerTool('update_route', {
    title: 'Update a route',
    description: 'Update a route by ID or slug.',
    inputSchema: z.object({
      route: refSchema,
      name: z.string().min(1).max(100).optional(),
      slug: z.string().min(2).max(80).regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
      strategy: z.enum(['fanout', 'fallback']).optional(),
      channelIds: z.array(z.string().min(1)).min(1).optional(),
      enabled: z.boolean().optional()
    }),
    annotations: { destructiveHint: false, openWorldHint: false }
  }, async ({ route: ref, ...input }) => {
    const current = await repository.getRoute(ref);
    if (!current) throw new Error('路由不存在');
    if (input.channelIds) throwErrors(await validateRouteChannelIds(repository, input.channelIds));
    const route = await repository.updateRoute(current.id, input, actor);
    return result({ route });
  });

  server.registerTool('delete_route', {
    title: 'Delete a route',
    description: 'Delete a route by ID or slug. Soft-disables it first if active deliveries depend on it.',
    inputSchema: z.object({ route: refSchema }),
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ route: ref }) => {
    const current = await repository.getRoute(ref);
    if (!current) throw new Error('路由不存在');
    await repository.deleteRoute(current.id, actor);
    return result({ deleted: true, id: current.id, slug: current.slug });
  });
}
```

注意：`assertKeyDestinations` 引入了但未使用——不要 import 它（删除该 import 项）。

- [ ] **Step 4: 修改 `src/server/mcp.ts`**

1. 签名与 import：

```typescript
import type { ProviderDispatcher } from './providers/dispatcher.js';
import { registerConfigTools } from './mcp-config.js';

export function createRelayMcpServer(repository: RelayRepository, notifications: NotificationService, dispatcher: ProviderDispatcher, apiKey: ApiKey, publicUrl = ''): McpServer {
```

2. `list_routes` 工具（30-37 行）改为：

```typescript
  server.registerTool('list_routes', {
    title: 'List notification routes',
    description: 'List routes this Agent can use (all routes when the key has config:write).',
    inputSchema: z.object({})
  }, async () => {
    if (apiKey.scopes.includes('config:write')) return result({ routes: await repository.listRoutes() });
    const allowed = new Set((await notifications.listDestinations(apiKey)).filter((item) => item.kind === 'route').map((item) => item.id));
    return result({ routes: (await repository.listRoutes()).filter((route) => route.enabled && allowed.has(route.id)) });
  });
```

3. `get_delivery` 注册之后（return server 之前）加：

```typescript
  if (apiKey.scopes.includes('config:write')) registerConfigTools(server, repository, dispatcher, apiKey);
```

4. `instructions` 改为按 scope 拼接：

```typescript
    instructions: 'Use list_destinations before sending. Call send_notification with an allowed destination slug or ID, then use get_delivery with the returned deliveryId when delivery status is needed. To ask the human a question, call ask_user, then poll check_reply with the returned conversationId until status is replied or the deadline passes. Never invent destination IDs.'
      + (apiKey.scopes.includes('config:write')
        ? ' When the user asks to set up or change notification channels or routes: call list_channel_types to learn the provider\'s required fields, ask the user for any missing required values, then create_channel, test_channel, and report the result. Never echo config values back to the user or logs.'
        : '')
```

5. handler 工厂签名：

```typescript
export function createRelayMcpHandler(repository: RelayRepository, notifications: NotificationService, dispatcher: ProviderDispatcher, publicUrl: (request?: Request) => string = () => '') {
```

- [ ] **Step 5: 更新两个调用点**

`src/server/app.ts:51`：`createRelayMcpHandler(repository, notifications, dispatcher, (request) => publicUrl(request ? new URL(request.url).origin : undefined))`
`src/worker/index.ts:83`：`this.mcp = createRelayMcpHandler(this.repository, this.notifications, this.dispatcher, (request) => request ? new URL(request.url).origin : '');`

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run tests/mcp-config.test.ts tests/app.test.ts` — PASS

- [ ] **Step 7: typecheck + commit**

Run: `npm run typecheck` — 无错误

```bash
git add src/server/mcp-config.ts src/server/mcp.ts src/server/app.ts src/worker/index.ts tests/mcp-config.test.ts
git commit -m "feat(mcp): config:write 配置工具集，Agent 可自然语言配置渠道与路由"
```

---

### Task 5: Web UI — Key 编辑 + scope 选项

**Files:**
- Modify: `src/web/api.ts`
- Modify: `src/web/components/Keys.tsx`

**Interfaces:**
- Consumes: Task 3 的 `PATCH /api/admin/keys/:id`；`SCOPE_IDS`（Task 1）。
- Produces: `api.updateKey(id: string, body: unknown): Promise<ApiKey>`；KeyForm 支持 `editing?: ApiKey` 预填编辑模式。

- [ ] **Step 1: `src/web/api.ts` 加方法（keys 段，39 行后）**

```typescript
  updateKey: (id: string, body: unknown) => request<ApiKey>(`/api/admin/keys/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
```

- [ ] **Step 2: `src/web/components/Keys.tsx` 改造 KeyForm**

1. Props 加 `editing?: ApiKey`；初始 state 由 editing 预填：

```typescript
export function KeyForm({
  destinations, close, saved, notify, editing
}: {
  destinations: Destination[];
  close: () => void;
  saved: () => void;
  notify: Notify;
  editing?: ApiKey;
}) {
  const [name, setName] = useState(editing?.name ?? '');
  const [scopes, setScopes] = useState<string[]>(editing?.scopes ?? ['notifications:send', 'deliveries:read']);
  const [restricted, setRestricted] = useState(Boolean(editing?.destinationIds.length));
  const [ids, setIds] = useState<string[]>(editing?.destinationIds ?? []);
```

2. `create` 提交函数改为分支：

```typescript
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      if (editing) {
        await api.updateKey(editing.id, { name, scopes, destinationIds: restricted ? ids : [] });
      } else {
        const result = await api.createKey({
          name, scopes, destinationIds: restricted ? ids : [],
          ...(customSecret ? { secret: customSecret } : {})
        });
        setSecret(result.secret);
      }
      saved();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };
```

3. SCOPE_OPTIONS 加第三项：

```typescript
  const SCOPE_OPTIONS = [
    { id: 'notifications:send', label: '发送通知' },
    { id: 'deliveries:read', label: '读取投递状态' },
    { id: 'config:write', label: '配置管理' }
  ] as const;
```

（`scopes` state 类型改 `string[]` 以容纳三项。）

4. Modal 标题与提交按钮：`title={editing ? '编辑 Agent API Key' : secret ? '保存 Agent API Key' : '创建 Agent API Key'}`；编辑模式提交按钮文案「保存修改」且不 disabled 于 `!scopes.length` 之外的条件同现状；编辑模式隐藏「自定义密钥」输入块（`{!editing && (…)}`）。

5. 编辑模式下提交成功不显示密钥屏（`submit` 已分支处理，`secret` 保持空）。

- [ ] **Step 3: Keys 列表接编辑入口**

1. state 加 `const [editingKey, setEditingKey] = useState<ApiKey | null>(null);`
2. 有效 key 的表格行操作区（244-249 行 row-actions）加编辑按钮（放「查看密钥」前）：

```tsx
<IconButton label="编辑范围" icon={Settings2} disabled={Boolean(busyId)} onClick={() => setEditingKey(key)} />
```

卡片视图同理（327 行区域）。import 加 `Settings2`（lucide-react）。
3. 挂编辑 Modal（文件底部 creating Modal 旁）：

```tsx
{editingKey && <KeyForm destinations={destinations} close={() => setEditingKey(null)} saved={() => { setEditingKey(null); refresh(); }} notify={notify} editing={editingKey} />}
```

4. scope 显示映射（表格 231 行、卡片 298 行）改三元为映射表：

```tsx
const SCOPE_LABELS: Record<string, string> = { 'notifications:send': '发送', 'deliveries:read': '读取', 'config:write': '配置' };
```

（`{key.scopes.map((scope) => <span key={scope}>{SCOPE_LABELS[scope] ?? scope}</span>)}`；卡片用 `.map((scope) => SCOPE_LABELS[scope] ?? scope).join('、')`。）

- [ ] **Step 4: 构建 + typecheck 验证**

Run: `npm run typecheck && npm run build:web` — 无错误

（UI 交互验证：启动 `npm run dev`（注意本机 4310 被 QQ 占用，需 `PORT=4321`），浏览器走一遍编辑流程：改名称/scope/目的地、保存、列表刷新生效。）

- [ ] **Step 5: commit**

```bash
git add src/web/api.ts src/web/components/Keys.tsx
git commit -m "feat(web): Key 范围编辑弹窗与 config:write 选项"
```

---

### Task 6: README 文档更新

**Files:**
- Modify: `README.md`（MCP 工具表 155-187 行段、安全模型 244 行）

- [ ] **Step 1: MCP 工具表追加行（`list_routes` 行后）**

```markdown
| `list_channel_types` | 列出渠道类型与字段定义（`config:write`） |
| `list_channels` / `create_channel` / `update_channel` / `delete_channel` | 渠道管理（`config:write`） |
| `test_channel` | 发送测试消息验证渠道连通性（`config:write`） |
| `create_route` / `update_route` / `delete_route` | 路由管理（`config:write`） |
```

- [ ] **Step 2: MCP 小节末尾加自然语言配置示例（工具表后）**

````markdown
给 Key 开启 `config:write` 权限后，可以直接对 Agent 说人话完成配置：

> 「帮我配一个 Telegram，Bot Token 是 123:abc，Chat ID 是 42，配好测一下」

Agent 会调用 `list_channel_types` 查字段 → `create_channel` 建渠道 → `test_channel` 验证连通 → 回报结果。所有变更写审计表（区分管理员与 Agent 操作）。
````

- [ ] **Step 3: 安全模型 244 行改写**

`- 每个 Agent Key 可限定 scope（发送/读取）与目的地白名单，一键吊销；` 改为：

```markdown
- 每个 Agent Key 可限定 scope（发送/读取/配置管理）与目的地白名单（如 5 个渠道开 5 个 Key 各管一个），可随时编辑范围，一键吊销；
```

- [ ] **Step 4: commit**

```bash
git add README.md
git commit -m "docs: config:write 与 MCP 配置工具说明"
```

---

### Task 7: 全量验证

- [ ] **Step 1: 全量测试 + 三 tsconfig typecheck + web 构建**

Run: `npm test && npm run typecheck && npm run build:web`
Expected: 全部通过

- [ ] **Step 2: 手动冒烟（可选但推荐）**

`PORT=4321 npm run dev` 起本地服务，浏览器 + curl 验证：
1. Keys 页创建含 `config:write` 的 key → 编辑其目的地白名单 → 保存生效；
2. 用该 key POST `/mcp` `tools/list` 看到 9 个配置工具；
3. `tools/call create_channel`（telegram，假 token）→ `test_channel` 返回 `success:false` 与 provider 错误；
4. 改窄白名单后 `/api/v1/notify` 发未授权目的地 → 403「API Key 无权访问该目的地」。

- [ ] **Step 3: 最终 commit（若有零散改动）**

```bash
git status --short
git add -A && git commit -m "chore: 收尾"
```
