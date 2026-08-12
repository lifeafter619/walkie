import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../src/server/config.js';
import { ProviderDispatcher } from '../src/server/providers/dispatcher.js';
import { assertSafeUrl } from '../src/server/providers/network.js';

const config = { allowPrivateWebhooks: true, allowInsecureHttp: false } as AppConfig;

describe('provider dispatcher', () => {
  it('builds a Telegram Bot API request', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const dispatcher = new ProviderDispatcher(config, fetcher);
    await dispatcher.send('telegram', { botToken: 'token123', chatId: '-1001' }, { title: 'Deploy', body: 'Done', severity: 'success', metadata: {} });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetcher).mock.calls[0];
    expect(String(url)).toContain('/bottoken123/sendMessage');
    expect(JSON.parse(String(init?.body))).toMatchObject({ chat_id: '-1001', text: 'Deploy\n\nDone' });
  });

  it('renders generic webhook variables as valid JSON text', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const dispatcher = new ProviderDispatcher(config, fetcher);
    await dispatcher.send('webhook', { url: 'https://hooks.example.com/incoming', method: 'POST', bodyTemplate: '{"subject":"{{title}}","text":"{{body}}","env":"{{environment}}"}' }, { title: 'A "quoted" title', body: 'line 1\nline 2', severity: 'info', metadata: { environment: 'prod' } });
    const init = vi.mocked(fetcher).mock.calls[0][1];
    expect(JSON.parse(String(init?.body))).toEqual({ subject: 'A "quoted" title', text: 'line 1\nline 2', env: 'prod' });
  });

  it('routes serverchan sendkeys to Turbo or Server酱³ endpoints', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const dispatcher = new ProviderDispatcher(config, fetcher);
    await dispatcher.send('serverchan', { sendKey: 'SCT1234abc' }, { title: 'T', body: 'B', severity: 'info', metadata: {} });
    expect(String(vi.mocked(fetcher).mock.calls[0][0])).toContain('https://sctapi.ftqq.com/SCT1234abc.send');
    await dispatcher.send('serverchan', { sendKey: 'sctp123tabcdef' }, { title: 'T', body: 'B', severity: 'warning', metadata: { tags: 'ci|prod', short: 'Short' } });
    const [url, init] = vi.mocked(fetcher).mock.calls[1];
    expect(String(url)).toBe('https://123.push.ft07.com/send/sctp123tabcdef.send');
    expect(JSON.parse(String(init?.body))).toMatchObject({ title: 'T', tags: 'ci|prod', short: 'Short' });
  });

  it('builds a WxPusher request and rejects empty targets', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 })) as unknown as typeof fetch;
    const dispatcher = new ProviderDispatcher(config, fetcher);
    await dispatcher.send('wxpusher', { appToken: 'AT_x', uids: 'UID_a\nUID_b' }, { title: 'T', body: 'B', severity: 'info', metadata: {} });
    const body = JSON.parse(String(vi.mocked(fetcher).mock.calls[0][1]?.body));
    expect(body).toMatchObject({ appToken: 'AT_x', uids: ['UID_a', 'UID_b'], contentType: 3 });
    await expect(dispatcher.send('wxpusher', { appToken: 'AT_x' }, { title: 'T', body: 'B', severity: 'info', metadata: {} })).rejects.toThrow('UID');
  });

  it('blocks insecure and private webhook targets by default', async () => {
    await expect(assertSafeUrl('http://example.com/hook', { allowPrivateWebhooks: false, allowInsecureHttp: false })).rejects.toThrow('HTTP 地址已禁用');
    await expect(assertSafeUrl('https://127.0.0.1/hook', { allowPrivateWebhooks: false, allowInsecureHttp: false })).rejects.toThrow('私网或回环');
  });
});
