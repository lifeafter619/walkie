import http from 'node:http';
import { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);

/** CLI 端到端（#15）：对 mock server 走真实子进程，验证 send/status/错误码 */
describe('walkie CLI', () => {
  it('sends notifications and fetches status against a Walkie-like server', async () => {
    const received: Array<{ auth: string | undefined; body: any }> = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url === '/api/v1/notify' && req.method === 'POST') {
          received.push({ auth: req.headers.authorization, body: JSON.parse(body) });
          res.statusCode = 202;
          res.end(JSON.stringify({ deliveryId: 'd-42', status: 'queued' }));
        } else if (req.url === '/api/v1/deliveries/d-42') {
          res.end(JSON.stringify({ id: 'd-42', status: 'delivered' }));
        } else {
          res.statusCode = 404;
          res.end('{}');
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const cli = (args: string[]) => run('node', ['packages/walkie-cli/walkie.mjs', ...args], {
      env: { ...process.env, WALKIE_URL: `http://127.0.0.1:${port}`, WALKIE_API_KEY: 'tok' }
    });

    const sent = await cli(['send', '--to', 'prod-alerts', '--title', '标题 T', '--body', '正文 B', '--severity', 'critical', '--link', 'https://example.com/run/1']);
    expect(sent.stdout.trim()).toBe('d-42');
    expect(received).toHaveLength(1);
    expect(received[0]!.auth).toBe('Bearer tok');
    expect(received[0]!.body).toMatchObject({ destination: 'prod-alerts', title: '标题 T', body: '正文 B', severity: 'critical', url: 'https://example.com/run/1' });

    const status = await cli(['status', 'd-42']);
    expect(JSON.parse(status.stdout)).toMatchObject({ id: 'd-42', status: 'delivered' });

    // --idempotency-key 落在 args['idempotency-key']，读 camelCase 会静默丢掉整个去重键
    await cli(['send', '--to', 'x', '--title', 't', '--body', 'b', '--idempotency-key', 'deploy-42']);
    expect(received[1]!.body).toMatchObject({ idempotencyKey: 'deploy-42' });

    await expect(cli(['send', '--to', 'x', '--title', 't', '--body', 'b', '--severity', 'bogus'])).rejects.toMatchObject({ code: 1 });
    server.close();
  }, 20_000);
});
