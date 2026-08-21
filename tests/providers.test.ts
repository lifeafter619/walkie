import { describe, expect, it, vi } from 'vitest';
import type { MockFetch } from './helpers.js';
import type { AppConfig } from '../src/server/config.js';
import { ProviderDispatcher, splitBody, splitBodyBytes } from '../src/server/providers/dispatcher.js';
import { assertSafeUrl } from '../src/server/providers/network.js';

const config = { allowPrivateWebhooks: true, allowInsecureHttp: false } as AppConfig;

// SMTP 测试需要 mock nodemailer（sendSmtp 直连 nodemailer，不走 fetcher）
const transportMock = { sendMail: vi.fn(async (opts: Record<string, unknown>) => ({ messageId: `<test-${opts.to}@walkie>` })) };
vi.mock('nodemailer', () => ({ default: { createTransport: vi.fn(() => transportMock) } }));

describe('provider dispatcher', () => {
  it('builds a Telegram Bot API request', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as MockFetch;
    const dispatcher = new ProviderDispatcher(config, fetcher);
    await dispatcher.send('telegram', { botToken: 'token123', chatId: '-1001' }, { title: 'Deploy', body: 'Done', severity: 'success', metadata: {} });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetcher).mock.calls[0];
    expect(String(url)).toContain('/bottoken123/sendMessage');
    expect(JSON.parse(String(init?.body))).toMatchObject({ chat_id: '-1001', text: 'Deploy\n\nDone' });
  });

  it('renders generic webhook variables as valid JSON text', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as MockFetch;
    const dispatcher = new ProviderDispatcher(config, fetcher);
    await dispatcher.send('webhook', { url: 'https://hooks.example.com/incoming', method: 'POST', bodyTemplate: '{"subject":"{{title}}","text":"{{body}}","env":"{{environment}}"}' }, { title: 'A "quoted" title', body: 'line 1\nline 2', severity: 'info', metadata: { environment: 'prod' } });
    const init = vi.mocked(fetcher).mock.calls[0][1];
    expect(JSON.parse(String(init?.body))).toEqual({ subject: 'A "quoted" title', text: 'line 1\nline 2', env: 'prod' });
  });

  it('forwards notifications to another Walkie instance with loop and retry protection', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 202 })) as unknown as MockFetch;
    const dispatcher = new ProviderDispatcher(config, fetcher);
    const message = { title: 'Deploy', body: 'Done', severity: 'success' as const, metadata: { walkieDeliveryId: 'delivery-1', walkieTrace: ['https://first.example.com'] } };
    await dispatcher.send('walkie', { server: 'https://second.example.com/', agentKey: 'rdk_remote', destination: 'ops' }, message);

    const [url, init] = vi.mocked(fetcher).mock.calls[0];
    expect(String(url)).toBe('https://second.example.com/api/v1/notify');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer rdk_remote');
    expect(JSON.parse(String(init?.body))).toMatchObject({ destination: 'ops', title: 'Deploy', idempotencyKey: 'walkie:delivery-1' });
    expect(JSON.parse(String(new Headers(init?.headers).get('x-walkie-trace')))).toEqual(['https://first.example.com', 'https://second.example.com']);

    await expect(dispatcher.send('walkie', { server: 'https://first.example.com', agentKey: 'rdk_remote', destination: 'ops' }, message)).rejects.toThrow('通知回环');
  });

  it('routes serverchan sendkeys to Turbo or Server酱³ endpoints', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as MockFetch;
    const dispatcher = new ProviderDispatcher(config, fetcher);
    await dispatcher.send('serverchan', { sendKey: 'SCT1234abc' }, { title: 'T', body: 'B', severity: 'info', metadata: {} });
    expect(String(vi.mocked(fetcher).mock.calls[0][0])).toContain('https://sctapi.ftqq.com/SCT1234abc.send');
    await dispatcher.send('serverchan', { sendKey: 'sctp123tabcdef' }, { title: 'T', body: 'B', severity: 'warning', metadata: { tags: 'ci|prod', short: 'Short' } });
    const [url, init] = vi.mocked(fetcher).mock.calls[1];
    expect(String(url)).toBe('https://123.push.ft07.com/send/sctp123tabcdef.send');
    expect(JSON.parse(String(init?.body))).toMatchObject({ title: 'T', tags: 'ci|prod', short: 'Short' });
  });

  it('builds a WxPusher request and rejects empty targets', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as MockFetch;
    const dispatcher = new ProviderDispatcher(config, fetcher);
    await dispatcher.send('wxpusher', { appToken: 'AT_x', uids: 'UID_a\nUID_b' }, { title: 'T', body: 'B', severity: 'info', metadata: {} });
    const body = JSON.parse(String(vi.mocked(fetcher).mock.calls[0][1]?.body));
    expect(body).toMatchObject({ appToken: 'AT_x', uids: ['UID_a', 'UID_b'], contentType: 3 });
    await expect(dispatcher.send('wxpusher', { appToken: 'AT_x' }, { title: 'T', body: 'B', severity: 'info', metadata: {} })).rejects.toThrow('UID');
  });

  it('uses the Apprise persistent key path and detects logical provider failures', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (String(url).includes('/notify/saved')) return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({ status: 'failed', retcode: 1404, message: 'not found' }), { status: 200 });
    }) as unknown as MockFetch;
    const dispatcher = new ProviderDispatcher(config, fetcher);
    await dispatcher.send('apprise', { server: 'https://apprise.example.com', configKey: 'saved' }, { title: 'T', body: 'B', severity: 'info', metadata: {} });
    expect(String(vi.mocked(fetcher).mock.calls[0][0])).toBe('https://apprise.example.com/notify/saved');
    await expect(dispatcher.send('onebot', { server: 'https://onebot.example.com', userId: '42' }, { title: 'T', body: 'B', severity: 'info', metadata: {} })).rejects.toThrow('not found');
  });

  it('detects non-HTTP failure responses from Synology Chat and Pushover', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) => new Response(String(url).includes('pushover')
      ? JSON.stringify({ status: 0, errors: ['invalid token'] })
      : JSON.stringify({ success: false, error: 'invalid token' }), { status: 200 })) as unknown as MockFetch;
    const dispatcher = new ProviderDispatcher(config, fetcher);
    await expect(dispatcher.send('synology-chat', { webhookUrl: 'https://synology.example.com/hook' }, { title: 'T', body: 'B', severity: 'info', metadata: {} })).rejects.toThrow('invalid token');
    await expect(dispatcher.send('pushover', { apiToken: 'a', userKey: 'u' }, { title: 'T', body: 'B', severity: 'info', metadata: {} })).rejects.toThrow('invalid token');
  });

  it('blocks insecure and private webhook targets by default', async () => {
    await expect(assertSafeUrl('http://example.com/hook', { allowPrivateWebhooks: false, allowInsecureHttp: false })).rejects.toThrow('HTTP 地址已禁用');
    await expect(assertSafeUrl('https://127.0.0.1/hook', { allowPrivateWebhooks: false, allowInsecureHttp: false })).rejects.toThrow('私网或回环');
  });
});

describe('long message chunking', () => {
  it('splits at newline boundaries and keeps every character', () => {
    const body = Array.from({ length: 300 }, (_, i) => `line ${i} of the incident report`).join('\n');
    const chunks = splitBody(body, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 1000)).toBe(true);
    expect(chunks.join('\n')).toBe(body);
    expect(splitBody('short', 1000)).toEqual(['short']);
  });

  it('splits UTF-8 payloads without exceeding the byte limit', () => {
    const chunks = splitBodyBytes('告警😀'.repeat(500), 900);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 900)).toBe(true);
    expect(chunks.join('')).toBe('告警😀'.repeat(500));
  });

  it('sends numbered parts for over-limit Telegram messages, url only on last', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as MockFetch;
    const dispatcher = new ProviderDispatcher(config, fetcher);
    await dispatcher.send('telegram', { botToken: 't', chatId: '1' }, { title: 'Report', body: 'x'.repeat(8000), severity: 'info', url: 'https://example.com/r', metadata: {} });
    const bodies = vi.mocked(fetcher).mock.calls.map((call) => JSON.parse(String(call[1]?.body)).text as string);
    expect(bodies.length).toBe(3);
    expect(bodies[0]).toContain('Report (1/3)');
    expect(bodies[0]).not.toContain('https://example.com/r');
    expect(bodies[2]).toContain('https://example.com/r');
  });

  it('splits ntfy messages at the documented 4096-byte limit', async () => {
    const fetcher = vi.fn(async () => new Response('', { status: 200 })) as unknown as MockFetch;
    const dispatcher = new ProviderDispatcher(config, fetcher);
    const body = '告警😀'.repeat(1500);
    await dispatcher.send('ntfy', { server: 'https://ntfy.sh', topic: 'ops' }, { title: 'T', body, severity: 'critical', metadata: {} });
    const payloads = vi.mocked(fetcher).mock.calls.map((call) => String(call[1]?.body ?? ''));
    expect(payloads.length).toBeGreaterThan(1);
    expect(payloads.every((part) => Buffer.byteLength(part, 'utf8') <= 4096)).toBe(true);
    expect(payloads.join('')).toBe(body);
  });
});

describe('new providers', () => {
  it('builds OneBot group message and PagerDuty event', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as MockFetch;
    const dispatcher = new ProviderDispatcher({ allowPrivateWebhooks: true, allowInsecureHttp: true } as AppConfig, fetcher);
    await dispatcher.send('onebot', { server: 'http://127.0.0.1:3000', groupId: '12345', accessToken: 'tok' }, { title: 'T', body: 'B', severity: 'info', metadata: {} });
    const [url, init] = vi.mocked(fetcher).mock.calls[0];
    expect(String(url)).toBe('http://127.0.0.1:3000/send_group_msg');
    expect(JSON.parse(String(init?.body))).toMatchObject({ group_id: 12345 });
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tok');

    await dispatcher.send('pagerduty', { routingKey: 'rk' }, { title: 'DB down', body: 'oops', severity: 'critical', metadata: { idempotencyKey: 'inc-1' } });
    const body = JSON.parse(String(vi.mocked(fetcher).mock.calls[1][1]?.body));
    expect(body).toMatchObject({ routing_key: 'rk', event_action: 'trigger', dedup_key: 'inc-1' });
    expect(body.payload.severity).toBe('critical');
  });

  it('maps severity to Bark critical level and feishu header color', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as MockFetch;
    const dispatcher = new ProviderDispatcher(config, fetcher);
    await dispatcher.send('bark', { server: 'https://api.day.app', deviceKey: 'k', callOnCritical: true, criticalVolume: 8 }, { title: 'T', body: 'B', severity: 'critical', metadata: {} });
    expect(JSON.parse(String(vi.mocked(fetcher).mock.calls[0][1]?.body))).toMatchObject({ level: 'critical', call: '1', volume: 8 });
    await dispatcher.send('bark', { server: 'https://api.day.app', deviceKey: 'k' }, { title: 'T', body: 'B', severity: 'info', metadata: { bark: { subtitle: 'Sub', group: 'Ops', badge: 3, sound: 'minuet' } } });
    expect(JSON.parse(String(vi.mocked(fetcher).mock.calls[1][1]?.body))).toMatchObject({ subtitle: 'Sub', group: 'Ops', badge: 3, sound: 'minuet' });
    await dispatcher.send('feishu', { webhookUrl: 'https://open.feishu.cn/hook/x' }, { title: 'T', body: 'B', severity: 'info', metadata: {} });
    expect(JSON.parse(String(vi.mocked(fetcher).mock.calls[2][1]?.body)).card.header.template).toBe('blue');
  });
});

describe('SMTP email', () => {
  it('passes host/port/secure/auth/from/to to nodemailer', async () => {
    // 清理上一次调用的记录
    vi.mocked(transportMock.sendMail).mockClear();
    const dispatcher = new ProviderDispatcher(config);
    await dispatcher.send('smtp', { host: 'smtp.exmail.qq.com', port: 465, secure: true, username: 'bot@corp.com', password: 'authcode', from: 'bot@corp.com', to: 'agent@claw.163.com' }, { title: '告警', body: 'CPU 95%', severity: 'critical', metadata: {} });
    expect(transportMock.sendMail).toHaveBeenCalledOnce();
    const opts = vi.mocked(transportMock.sendMail).mock.calls[0][0] as Record<string, unknown>;
    expect(opts).toMatchObject({ from: 'bot@corp.com', to: 'agent@claw.163.com', subject: '告警' });
    expect(String(opts.text)).toContain('CPU 95%');
  });

  it('blocks private SMTP hosts when allowPrivateWebhooks is false', async () => {
    const dispatcher = new ProviderDispatcher({ allowPrivateWebhooks: false, allowInsecureHttp: false } as AppConfig);
    await expect(dispatcher.send('smtp', { host: '10.0.0.5', port: 25, from: 'a@b.com', to: 'c@d.com' }, { title: 'T', body: 'B', severity: 'info', metadata: {} })).rejects.toThrow('私网或回环');
  });
});

