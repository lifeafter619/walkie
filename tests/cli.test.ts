import http from 'node:http';
import { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

  it('hook install merges into existing configs, is idempotent and uninstalls cleanly', async () => {
    // mock 服务端：hook 端点一律 200（probe 验证通过）
    const probed: any[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url?.startsWith('/api/v1/hooks/claude')) {
          probed.push({ auth: req.headers.authorization, body: JSON.parse(body) });
          res.statusCode = 200;
          res.end(JSON.stringify({ ok: true, deliveryId: 'd-1' }));
        } else { res.statusCode = 404; res.end('{}'); }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;

    // 隔离的假 HOME（Windows 上 homedir() 不看 $HOME，CLI 提供 WALKIE_HOME 覆盖）
    const home = mkdtempSync(join(tmpdir(), 'walkie-hook-cli-'));
    mkdirSync(join(home, '.claude'), { recursive: true });
    mkdirSync(join(home, '.cursor'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({
      model: 'sonnet',
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] }
    }, null, 2));
    writeFileSync(join(home, '.cursor', 'hooks.json'), JSON.stringify({
      version: 1, hooks: { beforeShellExecution: [{ command: './other.sh', timeout: 30 }] }
    }));

    const cli = (args: string[]) => run('node', ['packages/walkie-cli/walkie.mjs', ...args], {
      env: { ...process.env, WALKIE_HOME: home, WALKIE_URL: `http://127.0.0.1:${port}`, WALKIE_API_KEY: 'tok' }
    });

    // 安装
    const installed = await cli(['hook', '--tools', 'claude,cursor']);
    expect(installed.stdout).toContain('已写入');
    // probe 用真实 Stop 事件验证凭据（用户会收到一条确认通知）
    expect(probed[0]!.auth).toBe('Bearer tok');
    expect(probed[0]!.body.hook_event_name).toBe('Stop');

    const settings = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    expect(settings.model).toBe('sonnet'); // 用户配置必须保留（async readJson 回归）
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    const walkieEvents = ['Notification', 'Stop', 'StopFailure'].filter((event) => settings.hooks[event]);
    expect(walkieEvents).toHaveLength(3);
    expect(JSON.stringify(settings.hooks.Notification).includes('$WALKIE_TOKEN')).toBe(true);

    const cursorHooks = JSON.parse(readFileSync(join(home, '.cursor', 'hooks.json'), 'utf8'));
    expect(cursorHooks.hooks.beforeShellExecution).toHaveLength(1); // 用户已有 hook 保留
    expect(cursorHooks.hooks.stop?.[0]?.command).toContain('walkie-notify.sh');
    const script = readFileSync(join(home, '.cursor', 'hooks', 'walkie-notify.sh'), 'utf8');
    expect(script).toContain('/api/v1/hooks/claude');
    expect(script).toContain('${WALKIE_DESTINATION:+?destination=$WALKIE_DESTINATION}'); // 运行时展开，不写死

    // 幂等重装：handler 不重复
    await cli(['hook', '--tools', 'claude,cursor']);
    const again = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    expect(JSON.stringify(again.hooks).match(/hooks\/claude/g)?.length).toBe(3);

    // 卸载：只摘 walkie，用户配置原样
    await cli(['hook', '--tools', 'claude,cursor', '--uninstall']);
    const stripped = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    expect(['Notification', 'Stop', 'StopFailure'].filter((event) => stripped.hooks[event])).toHaveLength(0);
    expect(stripped.hooks.PreToolUse).toHaveLength(1);
    expect(stripped.model).toBe('sonnet');
    const cursorStripped = JSON.parse(readFileSync(join(home, '.cursor', 'hooks.json'), 'utf8'));
    expect(['stop', 'sessionEnd'].filter((event) => cursorStripped.hooks[event])).toHaveLength(0);
    expect(cursorStripped.hooks.beforeShellExecution).toHaveLength(1);
    expect(existsSync(join(home, '.cursor', 'hooks', 'walkie-notify.sh'))).toBe(false);

    rmSync(home, { recursive: true, force: true });
    server.close();
  }, 30_000);

  it('hook install refuses to write anything when the probe fails', async () => {
    const server = http.createServer((_req, res) => { res.statusCode = 401; res.end(JSON.stringify({ error: 'bad key' })); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const home = mkdtempSync(join(tmpdir(), 'walkie-hook-bad-'));
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), '{"model":"sonnet"}');
    await expect(run('node', ['packages/walkie-cli/walkie.mjs', 'hook', '--tools', 'claude'], {
      env: { ...process.env, WALKIE_HOME: home, WALKIE_URL: `http://127.0.0.1:${port}`, WALKIE_API_KEY: 'bad' }
    })).rejects.toMatchObject({ code: 2 });
    // 验证失败时绝不落盘
    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).toBe('{"model":"sonnet"}');
    rmSync(home, { recursive: true, force: true });
    server.close();
  }, 20_000);
});
