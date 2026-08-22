import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createNodeRepository } from '../src/server/database-node.js';
import type { RelayRepository } from '../src/server/database.js';
import { NotificationService } from '../src/server/notifications.js';
import { claudeHookToNotification, handleClaudeHook, parseMinSeverity } from '../src/server/claude-hook.js';
import { testConfig } from './helpers.js';
import { createApp } from '../src/server/app.js';
import { ProviderDispatcher } from '../src/server/providers/dispatcher.js';
import { DeliveryWorker } from '../src/server/queue.js';

const repositories: RelayRepository[] = [];
afterEach(() => repositories.splice(0).forEach((repository) => repository.close()));

const CWD = '/home/dev/walkie';

describe('claude hook event → notification mapping', () => {
  it('maps permission prompts to critical with the message body', () => {
    const mapped = claudeHookToNotification({
      hook_event_name: 'Notification', notification_type: 'permission_prompt',
      message: 'Claude needs your permission to run npm publish', cwd: CWD
    });
    expect(mapped).toMatchObject({ severity: 'critical', title: expect.stringContaining('walkie') });
    expect(mapped!.body).toContain('npm publish');
  });

  it('maps idle prompts to info and agent_completed to success', () => {
    expect(claudeHookToNotification({ hook_event_name: 'Notification', notification_type: 'idle_prompt', cwd: CWD })!.severity).toBe('info');
    expect(claudeHookToNotification({ hook_event_name: 'Notification', notification_type: 'agent_completed', cwd: CWD })!.severity).toBe('success');
  });

  it('maps Stop to success with the assistant summary, StopFailure to critical with error details', () => {
    const stop = claudeHookToNotification({ hook_event_name: 'Stop', last_assistant_message: '重构完成，182 个测试全绿。', cwd: CWD });
    expect(stop).toMatchObject({ severity: 'success' });
    expect(stop!.body).toContain('182 个测试全绿');

    const failure = claudeHookToNotification({ hook_event_name: 'StopFailure', error: 'rate_limit', error_details: '429 Too Many Requests', cwd: CWD });
    expect(failure).toMatchObject({ severity: 'critical' });
    expect(failure!.body).toContain('429');
  });

  it('ignores events with no action value instead of spamming (SessionEnd, PreToolUse, auth_success)', () => {
    expect(claudeHookToNotification({ hook_event_name: 'SessionEnd', reason: 'clear', cwd: CWD })).toBeUndefined();
    expect(claudeHookToNotification({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: CWD })).toBeUndefined();
    expect(claudeHookToNotification({ hook_event_name: 'Notification', notification_type: 'auth_success', cwd: CWD })).toBeUndefined();
  });

  it('truncates the cwd to the last two path segments', () => {
    const mapped = claudeHookToNotification({ hook_event_name: 'Stop', cwd: '/Users/someone/very/deeply/nested/project-x' });
    expect(mapped!.title).toContain('nested/project-x');
  });

  it('tolerates malformed field types instead of throwing (hook payloads are untrusted JSON)', () => {
    // 各家工具随手 POST 的 JSON：字段类型不可信。数字/对象/数组都不能把映射打成 500
    expect(() => claudeHookToNotification({ hook_event_name: 'Notification', notification_type: 42, message: 7, cwd: 99 })).not.toThrow();
    expect(() => claudeHookToNotification({ hook_event_name: 'stop', status: {}, workspace_roots: 'not-an-array' })).not.toThrow();
    expect(() => claudeHookToNotification({ type: [], hook_event_name: null })).not.toThrow();
    // 畸形 message 被丢掉后仍按事件语义处理，而不是崩溃或发出空正文
    const stop = claudeHookToNotification({ hook_event_name: 'Stop', last_assistant_message: { text: 'no' }, cwd: CWD });
    expect(stop!.body).toBe('回合结束，等待下一步指令。');
  });

  it('normalizes Cursor camelCase event names and maps stop.status / sessionEnd reason=error', () => {
    // Cursor: stop 带 status 字段（小驼峰事件名）
    const done = claudeHookToNotification({ hook_event_name: 'stop', status: 'completed', cwd: CWD });
    expect(done!.severity).toBe('success');
    const errored = claudeHookToNotification({ hook_event_name: 'stop', status: 'error', last_assistant_message: 'ENOSPC', cwd: CWD });
    expect(errored).toMatchObject({ severity: 'critical' });
    expect(errored!.body).toContain('ENOSPC');
    // 用户主动打断不打扰
    expect(claudeHookToNotification({ hook_event_name: 'stop', status: 'aborted' })).toBeUndefined();

    // Cursor: sessionEnd reason=error → critical；正常退出仍忽略
    const crash = claudeHookToNotification({ hook_event_name: 'sessionEnd', reason: 'error', message: 'OOM', cwd: CWD });
    expect(crash).toMatchObject({ severity: 'critical' });
    expect(claudeHookToNotification({ hook_event_name: 'sessionEnd', reason: 'clear' })).toBeUndefined();

    // PostToolUseFailure：只有主动挂它的工具（ZCode/Cursor）会送来，一律 warning
    expect(claudeHookToNotification({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash' })!.severity).toBe('warning');
    expect(claudeHookToNotification({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', cursor_version: '1.0', message: 'exit 1' })!.body).toContain('exit 1');
  });

  it('handles the payload shapes the other CLIs actually send', () => {
    // Cursor 的事件没有 cwd：项目名要从 workspace_roots 里拿，否则通知里认不出是哪个项目
    const cursor = claudeHookToNotification({ hook_event_name: 'stop', status: 'completed', workspace_roots: ['/home/me/Project/relaydock'] });
    expect(cursor!.title).toContain('Project/relaydock');

    // Cursor sessionEnd 的错误正文在 error_message 里
    const crashed = claudeHookToNotification({ hook_event_name: 'sessionEnd', reason: 'error', error_message: 'renderer died' });
    expect(crashed!.body).toContain('renderer died');

    // Codex / Qwen / ZCode：等你批准 → critical
    const ask = claudeHookToNotification({ hook_event_name: 'PermissionRequest', tool_name: 'Bash', cwd: CWD });
    expect(ask).toMatchObject({ severity: 'critical' });
    expect(ask!.body).toContain('Bash');

    // Gemini / Qwen / Droid 的 Notification 没有 notification_type，语义是「要你看一眼」
    const droid = claudeHookToNotification({ hook_event_name: 'Notification', message: 'Droid is waiting for your input', cwd: CWD });
    expect(droid).toMatchObject({ severity: 'critical' });
    // 没有任何正文的 Notification（auth_success 之类）仍然不打扰
    expect(claudeHookToNotification({ hook_event_name: 'Notification', notification_type: 'auth_success' })).toBeUndefined();
  });

  it('maps Gemini CLI AfterAgent and Codex notify agent-turn-complete payloads', () => {
    // Gemini CLI：AfterAgent（agent 循环结束）
    const gemini = claudeHookToNotification({ hook_event_name: 'AfterAgent', message: '重构完成', cwd: CWD });
    expect(gemini).toMatchObject({ severity: 'success' });
    expect(gemini!.body).toContain('重构完成');

    // Codex notify：无 hook_event_name，用 type=agent-turn-complete + kebab-case 字段
    const codex = claudeHookToNotification({ type: 'agent-turn-complete', 'last-assistant-message': '测试全绿', cwd: CWD });
    expect(codex).toMatchObject({ severity: 'success' });
    expect(codex!.body).toContain('测试全绿');
  });

  it('parseMinSeverity validates values', () => {
    expect(parseMinSeverity('critical')).toBe('critical');
    expect(parseMinSeverity('info')).toBe('info');
    expect(parseMinSeverity('bogus')).toBeUndefined();
    expect(parseMinSeverity(undefined)).toBeUndefined();
  });

  it('minSeverity filters lower-severity events but keeps critical ones', async () => {
    const repository = await createNodeRepository(':memory:', randomBytes(32));
    repositories.push(repository);
    const channel = await repository.createChannel({ name: 'T', slug: 't', provider: 'webhook', config: { url: 'https://hooks.example.com/t', method: 'POST', bodyTemplate: '{}' } });
    const { secret } = await repository.createKey({ name: 'k', destinationIds: [channel.id] });
    const notifications = new NotificationService(repository);
    const drain = () => undefined;

    // --only critical：任务完成（success）被过滤，不投递
    const filtered = await handleClaudeHook(repository, notifications, { hook_event_name: 'Stop', last_assistant_message: 'done' }, secret, undefined, drain, 'critical');
    expect(filtered.body).toMatchObject({ filtered: true, severity: 'success' });
    // 等你操作（critical）照常投递
    const urgent = await handleClaudeHook(repository, notifications, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'approve?' }, secret, undefined, drain, 'critical');
    expect(urgent.body).toMatchObject({ ok: true });
    const deliveries = await repository.listDeliveries({ limit: 5 });
    expect(deliveries.filter((item) => item.source === 'agent-hook')).toHaveLength(1);
    expect(deliveries.find((item) => item.source === 'agent-hook')?.severity).toBe('critical');
  });
});

describe('POST /api/v1/hooks/claude', () => {
  async function setup() {
    const repository = await createNodeRepository(':memory:', randomBytes(32));
    repositories.push(repository);
    const notifications = new NotificationService(repository);
    const dispatcher = new ProviderDispatcher(testConfig());
    const worker = new DeliveryWorker(repository, dispatcher, { deliveryWorkers: 1, maxDeliveryAttempts: 1, retryBaseMs: 1 });
    const app = createApp({ config: testConfig({ adminToken: 'x'.repeat(12) }), repository, notifications, dispatcher, worker });
    return { repository, notifications, app };
  }

  it('requires an agent key', async () => {
    const { app } = await setup();
    await request(app).post('/api/v1/hooks/claude').send({ hook_event_name: 'Stop' }).expect(401);
  });

  it('delivers a Stop notification through a single-destination key without ?destination', async () => {
    const { repository, app } = await setup();
    const channel = await repository.createChannel({ name: 'Hook', slug: 'hook', provider: 'webhook', config: { url: 'https://hooks.example.com/w', method: 'POST', bodyTemplate: '{}' } });
    const { secret } = await repository.createKey({ name: 'claude', destinationIds: [channel.id] });

    const response = await request(app).post('/api/v1/hooks/claude')
      .set('Authorization', `Bearer ${secret}`)
      .send({ hook_event_name: 'Stop', last_assistant_message: 'done', cwd: '/w/x' })
      .expect(200);
    expect(response.body).toMatchObject({ ok: true });

    const deliveries = await repository.listDeliveries({ limit: 5 });
    const sent = deliveries.find((item) => item.title.includes('Agent'));
    expect(sent?.severity).toBe('success');
    expect(sent?.source).toBe('agent-hook');
  });

  it('returns 200 with ignored:true for no-op events (Claude Code must not see hook errors)', async () => {
    const { repository, app } = await setup();
    const channel = await repository.createChannel({ name: 'Hook', slug: 'hook', provider: 'webhook', config: { url: 'https://hooks.example.com/w', method: 'POST', bodyTemplate: '{}' } });
    const { secret } = await repository.createKey({ name: 'claude', destinationIds: [channel.id] });

    const response = await request(app).post('/api/v1/hooks/claude')
      .set('Authorization', `Bearer ${secret}`)
      .send({ hook_event_name: 'SessionEnd', reason: 'clear' })
      .expect(200);
    expect(response.body).toMatchObject({ ignored: true });
    expect((await repository.listDeliveries({ limit: 5 })).find((item) => item.source === 'agent-hook')).toBeUndefined();
  });

  it('surfaces a clear error when the key has multiple destinations and none was given', async () => {
    const { repository, app } = await setup();
    const a = await repository.createChannel({ name: 'A', slug: 'a', provider: 'webhook', config: { url: 'https://hooks.example.com/a', method: 'POST', bodyTemplate: '{}' } });
    const b = await repository.createChannel({ name: 'B', slug: 'b', provider: 'webhook', config: { url: 'https://hooks.example.com/b', method: 'POST', bodyTemplate: '{}' } });
    const { secret } = await repository.createKey({ name: 'claude', destinationIds: [a.id, b.id] });

    const missing = await request(app).post('/api/v1/hooks/claude')
      .set('Authorization', `Bearer ${secret}`)
      .send({ hook_event_name: 'Stop' }).expect(400);
    expect(missing.body.error).toContain('目的地');

    // ?destination=<slug> 显式指定后成功
    const withDestination = await request(app).post('/api/v1/hooks/claude?destination=a')
      .set('Authorization', `Bearer ${secret}`)
      .send({ hook_event_name: 'Stop', last_assistant_message: 'ok' });
    expect(withDestination.status).toBe(200);
    expect(withDestination.body).toMatchObject({ ok: true });
    expect(typeof withDestination.body.deliveryId).toBe('string');
  });

  it('handleClaudeHook maps permission waits to critical severity end-to-end', async () => {
    const repository = await createNodeRepository(':memory:', randomBytes(32));
    repositories.push(repository);
    const channel = await repository.createChannel({ name: 'T', slug: 't', provider: 'webhook', config: { url: 'https://hooks.example.com/t', method: 'POST', bodyTemplate: '{}' } });
    const { secret, apiKey } = await repository.createKey({ name: 'k', destinationIds: [channel.id] });
    void apiKey;
    const result = await handleClaudeHook(repository, new NotificationService(repository), {
      hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'approve rm -rf?'
    }, secret, undefined, () => undefined);
    expect(result.statusCode).toBe(200);
    const deliveries = await repository.listDeliveries({ limit: 5 });
    expect(deliveries.find((item) => item.source === 'agent-hook')?.severity).toBe('critical');
  });
});
