# RelayDock 代码审计报告

> 审计范围：全部源码（`src/`、`api/`）、测试（`tests/`）及配置文件（`wrangler.jsonc`、`tsconfig.*.json`、`worker-configuration.d.ts`）。
> 运行时：多运行时（Node/Express、Cloudflare Workers Durable Object、Vercel Serverless）自托管 MCP 通知控制平面。

---

## 概览

| 严重程度 | 数量 |
|----------|------|
| 🔴 严重 / High | 3 |
| 🟠 中等 / Medium | 6 |
| 🟡 低 / Low | 6 |
| **合计** | **15** |

**最关键的三个问题**：

1. 管理员令牌使用非恒定时间字符串比较，存在时序攻击风险（`app.ts:52`、`worker/index.ts:83`）。
2. fallback 路由在多实例部署下并发投递，破坏顺序语义（`database.ts:344-347`）。
3. 幂等键存在 TOCTOU 竞态，并发重试返回 409 而非去重结果（`database.ts:271-290`）。

---

## 🔴 严重 / High

### 1. 管理员令牌使用非恒定时间比较（时序攻击）

**位置**：`src/server/app.ts:52`、`src/worker/index.ts:83`

```ts
// app.ts — API Key 用了 safeSecretEqual，但 admin token 用 ===
if (!config.adminToken || bearer(req) === config.adminToken || req.header('x-admin-token') === config.adminToken) return next();
// worker/index.ts
if (bearer(request) === this.env.ADMIN_TOKEN || request.headers.get('x-admin-token') === this.env.ADMIN_TOKEN) return;
```

**问题**：API Key 的校验使用了 `safeSecretEqual`（恒定时间，`crypto.ts:29`），但管理员令牌在两处都用 `===` 普通字符串比较。尽管令牌要求 ≥24 字符，时序攻击在网络上仍可放大逐字节猜测。代码库已有 `safeSecretEqual`，却未复用。

**影响**：攻击者理论上可通过时序差异逐字节还原 ADMIN_TOKEN，获得全部管理权限。

**修复**：用 `safeSecretEqual`（或对原始 token 做 `timingSafeEqual`）替换 `===`。

---

### 2. fallback 路由在多实例部署下并发投递，破坏顺序语义

**位置**：`src/server/database.ts:344-347`

```sql
AND a.position=(SELECT MIN(next.position) FROM attempts next
  WHERE next.delivery_id=a.delivery_id AND next.status IN ('pending','retrying'))
```

**问题**：fallback 策略要求“先发第一个频道，失败后再发第二个”。但这条 SQL 在计算“最早可领取的 attempt”时，只看 `pending`/`retrying` 状态，**没有把 `sending`（在途）算进去**。当频道 0 已被领取为 `sending` 但尚未完成时，频道 1 的 `position` 就成了 `MIN(pending/retrying)` 中的最小值，变得可领取。

单实例下 `DeliveryWorker.running` 标志（`queue.ts:88`）恰好串行化了 drain，掩盖了此 bug。但在 **Vercel 多实例 / 多 Node 进程**下，两个实例各自独立 drain：

1. 实例 A 领取频道 0 → 状态变 `sending`
2. 实例 B 查询：频道 0 是 `sending`（不在 `pending/retrying` 中），频道 1 是 `MIN` → 领取频道 1
3. 两个频道同时投递，fallback 语义被破坏

测试 `queue.test.ts:9` 未暴露此 bug，因为 mock `send` 是同步即时返回的，没有覆盖“频道 0 在途”的时间窗。

**影响**：fallback 路由在 Vercel 等多实例环境下退化为 fanout，备用频道被无谓消耗（如付费短信、PagerDuty 事件）。

**修复**：MIN 子查询应包含 `sending` 状态，或额外排除“存在更早 position 且非终态的 attempt”：

```sql
AND NOT EXISTS (
  SELECT 1 FROM attempts earlier
  WHERE earlier.delivery_id=a.delivery_id AND earlier.position<a.position
    AND earlier.status IN ('pending','sending','retrying')
)
```

---

### 3. 幂等键存在 TOCTOU 竞态，并发重试返回 409 而非去重结果

**位置**：`src/server/database.ts:271-290`

```ts
if (input.idempotencyKey) {
  const existing = await this.db.get('SELECT id FROM deliveries WHERE source=? AND idempotency_key=?', [...]);
  if (existing) return (await this.getDelivery(String(existing.id)))!;  // ← SELECT 在事务外
}
// ...然后 batch INSERT（事务内）
```

**问题**：幂等检查（SELECT）和插入（batch INSERT）不在同一事务内。两个携带相同 `idempotencyKey` 的并发请求都能通过 SELECT，第二个 INSERT 撞 UNIQUE 索引抛错，被错误处理映射为 **409 Conflict**（`app.ts:231`、`worker/index.ts:167`）。Agent 收到 409 而非已创建的 deliveryId——正是幂等键要避免的场景（网络超时后重试）。

**影响**：Agent 重试时若原请求仍在处理中，会收到 409 而非 deliveryId，无法继续追踪投递。

**修复**：用 SQLite `INSERT ... ON CONFLICT(source, idempotency_key) DO NOTHING` 配合 `RETURNING`，或捕获 UNIQUE 异常后重新 `getDelivery`。

---

## 🟠 中等 / Medium

### 4. `quietUntil` 时区在 Cloudflare Workers 上错误

**位置**：`src/server/queue.ts:7-19`

```ts
const minutes = at.getHours() * 60 + at.getMinutes();  // ← 本地时间
```

**问题**：注释写“服务器本地时间”。Node 运行时下 `getHours()` 返回服务器时区，但 **Cloudflare Workers 运行在 UTC**，`getHours()` 恒返回 UTC 时间。用户配置 `22:00-08:00` 静默期期望的是本地时间，在 Workers 上会被当成 UTC 解读，静默时段完全错位。

**影响**：Workers 部署的静默时段不生效或错位，用户在错误的时间被静默/打扰。

**修复**：让用户显式指定时区，或用 UTC 存储并在 UI 标注。

---

### 5. `refreshDeliveryStatus` 的非空断言在并发删除下会抛异常

**位置**：`src/server/database.ts:450`

```ts
const delivery = (await this.db.get('SELECT target_type,target_id FROM deliveries WHERE id=?', [deliveryId]))!;
```

**问题**：`!` 非空断言。若 delivery 在 `completeAttempt` 和 `refreshDeliveryStatus` 之间被删除（或并发 admin 操作），`delivery` 为 `undefined`，后续 `delivery.target_type` 抛 `TypeError`，导致整个 drain 异常。虽然 delivery 通常不会被删除，但 `ON DELETE CASCADE`（attempts 引用 deliveries）和未来的清理任务可能触发。

**修复**：判空并提前返回。

---

### 6. API Key 前缀碰撞导致建钥失败

**位置**：`src/server/crypto.ts:36`、`database.ts:230`

```ts
const prefix = Buffer.from(randomBytes(4)).toString('hex');  // 32 位，8 hex 字符
// ...prefix 有 UNIQUE 约束
```

**问题**：前缀仅 32 位（8 hex 字符），且 `api_keys.prefix` 有 `UNIQUE` 约束。生日攻击下约 65,536 个 key 有 50% 碰撞概率。碰撞时第二个 `createKey` 的 INSERT 撞 UNIQUE，返回 409，管理员看到建钥失败。被吊销的 key 也永久占用其前缀。

**影响**：规模化使用后偶发建钥失败；碰撞概率虽低但不可忽略。

**修复**：加长前缀到 6 字节（48 位），或碰撞时自动重试生成。

---

### 7. SMTP 渠道绕过 SSRF 防护

**位置**：`src/server/providers/dispatcher.ts:236-244`

```ts
private async sendSmtp(config, message): Promise<ProviderResult> {
  const transporter = nodemailer.createTransport({
    host: string(config, 'host'), port: Number(config.port ?? 587), ...
  });  // ← 不经过 assertSafeUrl / safeFetch
```

**问题**：所有 HTTP 类渠道通过 `safeFetch` → `assertSafeUrl` 做 SSRF 防护（禁止私网/回环）。但 SMTP 直接用 nodemailer 连接，不经过任何地址校验。管理员若误配 `host: 127.0.0.1` 或内网地址，即使 `ALLOW_PRIVATE_WEBHOOKS=false` 也会连接成功。虽然 SMTP 配置由管理员控制，但与 HTTP 渠道的防护策略不一致。

**修复**：对 SMTP host 也做 `isPrivateAddress` 校验（除非 `allowPrivateWebhooks`）。

---

### 8. `assertSafeUrl` 存在 DNS rebinding TOCTOU

**位置**：`src/server/providers/network.ts:36-50`

```ts
const addresses = await resolveHost(url.hostname);  // ← 解析校验
if (!addresses.length || addresses.some(isPrivateAddress)) throw new Error(...);
// ...然后 fetcher(url, ...) 再次独立解析 DNS ← 可能解析到不同 IP
```

**问题**：校验阶段和实际 fetch 阶段是两次独立的 DNS 解析。攻击者控制的 DNS 服务器可在第一次返回公网 IP（通过校验），第二次返回内网 IP（实际访问）。`redirect: 'error'` 阻止了重定向 SSRF，但无法防 DNS rebinding。

**影响**：Agent 通过 `callbackUrl` 仍可能触达内网（需攻击者控制 DNS）。这是业界公认难题，但值得记录。

**修复**：校验后将解析到的 IP 固定用于实际连接（如自定义 `fetch` dispatcher 或 `Host` 头 + IP 直连）。

---

### 9. `isPrivateAddress` 遗漏部分保留地址段

**位置**：`src/server/providers/network.ts:10-18`

**问题**：未覆盖 `100.64.0.0/10`（CGNAT）、`198.18.0.0/15`（基准测试）、`192.0.2.0/24`（文档用途）等。CGNAT 地址 `100.64.x.x` 不会被判定为私网，可绕过 SSRF 防护访问内网服务。

**修复**：补充 `100.64/10` 等保留段，或改用成熟的 IP 范围库。

---

## 🟡 低 / Low

### 10. Worker 构造函数用 `as never` 绕过类型检查

**位置**：`src/worker/index.ts:60`

```ts
this.dispatcher = new ProviderDispatcher({
  allowPrivateWebhooks: enabled(env.ALLOW_PRIVATE_WEBHOOKS),
  allowInsecureHttp: enabled(env.ALLOW_INSECURE_HTTP)
} as never, fetch, resolveHost);
```

**问题**：`ProviderDispatcher` 构造函数要求 `AppConfig`，这里只传了两个字段并用 `as never` 绕过类型。运行时只读这两个字段所以暂时没问题，但若 dispatcher 后续新增对其他 config 字段的访问，TypeScript 不会报错，运行时得到 `undefined`。

**修复**：定义 `Pick<AppConfig, 'allowPrivateWebhooks' | 'allowInsecureHttp'>` 作为 dispatcher 参数类型。

---

### 11. `renderTemplate` 未转义全部 JSON 控制字符

**位置**：`src/server/providers/dispatcher.ts:43-49`

```ts
return typeof value === 'string'
  ? value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')
  : JSON.stringify(value ?? '');
```

**问题**：webhook 渠道的 JSON 模板渲染只转义了 `\`、`"`、换行，但未转义制表符（`\t`）、回车（`\r`）、空字节（`\0`）等 JSON 规范要求转义的控制字符（U+0000–U+001F）。若消息体含这些字符，生成的 JSON 会非法，导致目标服务解析失败。

**修复**：改用 `JSON.stringify(value)` 对整个字符串值做完整转义，而非手动 `replace`。

---

### 12. 内存限流器不跨实例共享

**位置**：`src/server/queue.ts:26`

```ts
// ponytail: 内存滑动窗口限流，进程重启后窗口清零
private readonly sentAt = new Map<string, number[]>();
```

**问题**：注释已承认此限制。在 Vercel 多实例下，每个函数实例有独立限流窗口，实际发送量 = 实例数 × `maxSendsPerMin`，远超配置上限。同样 `channel.rateLimitPerMin` 也被绕过。

**影响**：多实例部署下限流失效，可能触发上游平台风控。

**修复**：改为按 `attempts` 表统计（注释中也建议了），或引入共享存储（Redis/DO 计数器）。

---

### 13. `drainOnce` 每条 attempt 单独查 delivery 和 channel（N+1）

**位置**：`src/server/queue.ts:92-94`

```ts
await Promise.all(attempts.map(async (attempt) => {
  const delivery = await this.repository.getDelivery(attempt.deliveryId);   // 每条一次
  const channel = await this.repository.getChannel(attempt.channelId);     // 每条一次
```

**问题**：fanout 路由下多个 attempt 属于同一 delivery，但每条 attempt 都重复查一次 delivery（含 attempts 子查询）。`deliveryWorkers` 上限 16，最坏 16 次冗余查询。

**修复**：按 `deliveryId` 分组，共享查询结果。

---

### 14. Worker 与 Express 的管理员鉴权策略不一致

**位置**：`src/worker/index.ts:82` vs `src/server/app.ts:52`

```ts
// Worker：缺 token 返回 503
if (!this.env.ADMIN_TOKEN) return json({ error: 'ADMIN_TOKEN secret is required' }, 503);
// Express：缺 token 直接放行（dev 模式）
if (!config.adminToken || bearer(req) === ...) return next();
```

**问题**：Worker 强制要求 ADMIN_TOKEN，Express 在未配置时开放管理 API。若用户在非环回地址上以非 production 模式运行 Express 但忘记设置 ADMIN_TOKEN，`config.ts:54` 虽有保护，但 `NODE_ENV` 非法值或 `host` 配置为环回但实际暴露（反向代理）时，管理端点可能无鉴权暴露。

**修复**：统一策略，或至少在 Express 无 token 时记录醒目警告。

---

### 15. Server酱兼容入口将 API Key 暴露在 URL 路径中

**位置**：`src/server/app.ts:212`、`src/worker/index.ts:156`

```ts
app.get(/^\/(?:send\/)?(rdk_[a-f0-9]{8}_[A-Za-z0-9_-]+)\.send$/, serverchanCompat);
```

**问题**：这是 Server酱 协议的固有设计，但 API Key 出现在 URL 路径中会被记录在访问日志、反向代理日志、Referer 头中，增加泄露风险。

**影响**：Key 泄露后可冒充 Agent 发送通知（但受 destinationIds 白名单限制）。

**建议**：文档中提示此风险；考虑为 Server酱 入口单独签发短生命周期的 SendKey。

---

## ✅ 正面发现

- **加密存储**：渠道凭据用 AES-256-GCM + 随机 IV 认证加密（`crypto.ts:5-11`），`Channel` 接口不暴露明文，`configKeys` 只返回键名。测试覆盖了密钥错误场景。
- **回复链接一次性**：`replyConversation` 用原子 `UPDATE ... WHERE replied_at IS NULL AND expires_at>?` 保证幂等，重复提交返回 410。HTML 转义到位（`escapeHtml`）。
- **回调只发一次**：`claimCallback` 用原子 `json_set(metadata,'$.callbackSent',1) WHERE ... IS NULL`，配合测试验证。
- **SSRF 基础防护**：`assertSafeUrl` 禁止 URL 凭据、强制 HTTPS（可配）、私网/回环检测、`redirect: 'error'`、12s 超时、4096 字节响应截断。Agent 提供的 `callbackUrl` 也经过校验。
- **Body 大小限制**：`readBody` 同时校验 `content-length` 头和流式实际字节，防伪造头绕过。
- **分片投递**：长消息按渠道上限切分，在换行处断开，链接只挂最后一片。

---

## 修复优先级建议

| 优先级 | 问题 | 建议方式 |
|--------|------|----------|
| **立即** | #1 管理员令牌时序攻击 | 用 `safeSecretEqual` 替换 `===` |
| **立即** | #2 fallback 多实例并发 | 修 SQL 查询，纳入 `sending` 状态 |
| **本迭代** | #3 幂等键 TOCTOU | 用 `ON CONFLICT DO NOTHING` + 重查 |
| **本迭代** | #4 静默时段时区 | 显式时区或 UTC 标注 |
| **下迭代** | #5–#9 中等问题 | 逐项修复 |
| **长期** | #10–#15 低优先级 | 重构/加固 |
