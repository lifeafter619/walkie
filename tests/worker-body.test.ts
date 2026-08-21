import { describe, expect, it } from 'vitest';
import { BodyTooLargeError, readBody } from '../src/worker/body.js';

describe('worker body limits', () => {
  it('rejects oversized chunked bodies before buffering them', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(262_144));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      }
    });
    await expect(readBody(new Request('https://relay.example.com/api', { method: 'POST', body, duplex: 'half' } as RequestInit))).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  // Gotify 官方示例 curl -F 走 multipart；此前 readBody 会把它当 urlencoded 解出垃圾键
  it('parses multipart/form-data fields (Gotify curl -F compatibility)', async () => {
    const boundary = '----walkie-test';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nfrom curl -F\r\n--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\nmultipart body\r\n--${boundary}\r\nContent-Disposition: form-data; name="priority"\r\n\r\n8\r\n--${boundary}--\r\n`;
    const request = new Request('https://relay.example.com/message', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body
    });
    await expect(readBody(request)).resolves.toEqual({ title: 'from curl -F', message: 'multipart body', priority: '8' });
  });

  it('ignores file parts but keeps other fields in multipart bodies', async () => {
    const boundary = '----walkie-test';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\ntext value\r\n--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nfile content\r\n--${boundary}--\r\n`;
    const request = new Request('https://relay.example.com/message', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body
    });
    const parsed = await readBody(request);
    expect(parsed.message).toBe('text value');
    expect(parsed.attachment).toBeUndefined();
  });
});

/**
 * Worker 入口的兜底分流正则：决定一个路径是交给 Durable Object 还是静态资源。
 * run_worker_first 让 Worker 先跑，被它接走的路径不会再回落到 ASSETS——
 * /sw.js 曾因此在 Cloudflare 上 404，Web Push 的 Service Worker 注册不了。
 */
describe('worker entry routing', () => {
  const catchAll = /^\/(?!assets(?:\/|$)|[^/]*\.[^/]+$)[^/]+(?:\/[^/]+){0,3}$/;
  const serverchan = /^\/(?:send\/)?[^/]+\.send$/;
  const toDurableObject = (path: string) =>
    path === '/health' || path === '/openapi.json' || path === '/push' || path === '/ping'
    || path === '/healthz' || path === '/info' || path === '/register' || path.startsWith('/register/')
    || path === '/mcp' || path.startsWith('/api/') || path.startsWith('/reply/')
    || serverchan.test(path) || catchAll.test(path);

  it('leaves root-level static files to ASSETS', () => {
    for (const path of ['/sw.js', '/favicon.ico', '/robots.txt', '/manifest.webmanifest', '/assets/index-abc.js']) {
      expect(toDurableObject(path), path).toBe(false);
    }
  });

  it('still routes app, compat and bark paths to the Durable Object', () => {
    for (const path of [
      '/health', '/openapi.json', '/mcp', '/api/admin/inbox', '/api/webhooks/123/key',
      '/reply/abc/def', '/alertmanager', '/1/messages.json', '/notify/KEY',
      '/services/T/B/KEY', '/telegram/webhook/secret', '/slack/interactive/secret', '/slack/events/secret', '/discord/interactions/secret',
      '/mykey.send', '/send/mykey.send', '/deviceKey', '/deviceKey/title/body'
    ]) {
      expect(toDurableObject(path), path).toBe(true);
    }
  });
});

/** OpenAPI 是对外契约；结构坏掉时 /openapi.json 会整条 500，值得钉住 */
describe('openapi spec', () => {
  it('covers the agent, admin and platform-callback surfaces and stays serializable', async () => {
    const { openApiSpec } = await import('../src/shared/openapi.js');
    const spec = openApiSpec('https://walkie.test') as Record<string, any>;
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.servers[0].url).toBe('https://walkie.test');
    expect(Object.keys(spec.components.securitySchemes)).toEqual(['bearerAuth', 'adminAuth']);

    const paths = Object.keys(spec.paths);
    for (const required of [
      '/api/v1/notify', '/api/v1/ask', '/api/v1/conversations/{id}',
      '/api/admin/channels', '/api/admin/channels/{id}', '/api/admin/inbox', '/api/admin/webpush',
      '/telegram/webhook/{secret}', '/slack/interactive/{secret}', '/slack/events/{secret}', '/discord/interactions/{secret}'
    ]) {
      expect(paths, required).toContain(required);
    }
    // 每个操作都要显式声明 security（哪怕是空数组表示公开），别让读者去猜
    for (const [path, item] of Object.entries(spec.paths as Record<string, Record<string, any>>)) {
      for (const [method, operation] of Object.entries(item)) {
        expect(operation.security, `${method.toUpperCase()} ${path}`).toBeDefined();
        expect(operation.summary, `${method.toUpperCase()} ${path}`).toBeTruthy();
      }
    }
    expect(() => JSON.parse(JSON.stringify(spec))).not.toThrow();
  });
});
