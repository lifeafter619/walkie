import http from 'node:http';
import { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const run = promisify(execFile);
const SCRIPT = 'walkie-notify.sh';

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
        if (req.url?.startsWith('/api/v1/hooks/')) {
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
    expect(script).toContain('/api/v1/hooks/agent');
    expect(script).toContain('destination=$WALKIE_DESTINATION'); // 运行时展开，不写死
    expect(script).toContain('${query:+?$query}'); // ? 由第一个查询参数补——没有 destination 时 min_severity 也能拼出合法 URL
    expect(script).toContain('min_severity=$WALKIE_MIN_SEVERITY'); // 级别可后调，无需重装

    // 幂等重装：handler 不重复
    await cli(['hook', '--tools', 'claude,cursor']);
    const again = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    expect(JSON.stringify(again.hooks).match(/hooks\/agent/g)?.length).toBe(3);

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

  it('installs codex/zcode/gemini/droid with their distinct config shapes and bakes --only into the URL', async () => {
    const server = http.createServer((_req, res) => { res.statusCode = 200; res.end(JSON.stringify({ ok: true, deliveryId: 'd-1' })); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const home = mkdtempSync(join(tmpdir(), 'walkie-hook-multi-'));
    for (const dir of ['.codex', ['.zcode', 'cli'], '.gemini', '.factory']) {
      mkdirSync(join(home, ...(Array.isArray(dir) ? dir : [dir])), { recursive: true });
    }
    writeFileSync(join(home, '.zcode', 'cli', 'config.json'), JSON.stringify({ theme: 'dark' })); // 用户已有配置必须保留

    const cli = (extra: string[]) => run('node', ['packages/walkie-cli/walkie.mjs', 'hook', '--tools', 'codex,zcode,gemini,droid', ...extra], {
      env: { ...process.env, WALKIE_HOME: home, WALKIE_URL: `http://127.0.0.1:${port}`, WALKIE_API_KEY: 'tok' }
    });

    const out = await cli(['--only', 'critical']);
    expect(out.stdout).toContain('Codex');
    expect(out.stdout).toContain('ZCode');
    expect(out.stdout).toContain('Gemini');
    expect(out.stdout).toContain('Droid');

    // Codex：hooks.json 用的是 Claude 式嵌套 schema（事件 → 组 → handler），不是 Cursor 的扁平形状
    const codex = JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8'));
    expect(codex.hooks.Stop[0].hooks[0].command).toContain('walkie-notify.sh');
    expect(codex.hooks.PermissionRequest[0].hooks[0].type).toBe('command');

    // Droid：.factory/hooks.json 事件直接在顶层，没有 hooks 包装层
    const droid = JSON.parse(readFileSync(join(home, '.factory', 'hooks.json'), 'utf8'));
    expect(droid.hooks).toBeUndefined();
    expect(droid.Stop[0].hooks[0].command).toContain('walkie-notify.sh');
    expect(droid.Notification[0].hooks[0].type).toBe('command');

    // ZCode：config.json 的 hooks.events 结构 + enabled:true；用户主题保留
    const zcode = JSON.parse(readFileSync(join(home, '.zcode', 'cli', 'config.json'), 'utf8'));
    expect(zcode.theme).toBe('dark');
    expect(zcode.hooks.enabled).toBe(true);
    expect(zcode.hooks.events.Stop[0].hooks[0].command).toContain('walkie-notify.sh');
    expect(zcode.hooks.events.PostToolUseFailure[0].hooks[0].type).toBe('command');

    // Gemini：settings.json 的 hooks.<Event> 结构（AfterAgent/Notification）
    const gemini = JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8'));
    expect(gemini.hooks.AfterAgent[0].hooks[0].command).toContain('walkie-notify.sh');
    expect(gemini.hooks.Notification[0].hooks[0].timeout).toBe(15000); // Gemini 用毫秒

    // --only critical 已烧进脚本 URL：级别随安装走，不用动服务端
    const script = readFileSync(join(home, '.codex', 'hooks', SCRIPT), 'utf8');
    expect(script).toContain('min_severity=critical');

    // 卸载：ZCode 摘空后 hooks 块清理，用户 theme 保留
    await cli(['--uninstall']);
    const zcodeAfter = JSON.parse(readFileSync(join(home, '.zcode', 'cli', 'config.json'), 'utf8'));
    expect(zcodeAfter.theme).toBe('dark');
    expect(zcodeAfter.hooks).toBeUndefined();
    const codexAfter = JSON.parse(readFileSync(join(home, '.codex', 'hooks.json'), 'utf8'));
    expect(codexAfter.hooks).toBeUndefined();
    const droidAfter = JSON.parse(readFileSync(join(home, '.factory', 'hooks.json'), 'utf8'));
    expect(droidAfter.Stop).toBeUndefined();
    expect(existsSync(join(home, '.gemini', 'hooks', SCRIPT))).toBe(false);

    // 卸载空跑：从未装过 hooks 的工具（无配置文件）不能被凭空创建文件，
    // 已有配置不能被重排——只有真的摘到 walkie handler 才写盘
    const untouchedHome = mkdtempSync(join(tmpdir(), 'walkie-hook-noop-'));
    mkdirSync(join(untouchedHome, '.claude'), { recursive: true });
    mkdirSync(join(untouchedHome, '.qwen'), { recursive: true });
    writeFileSync(join(untouchedHome, '.claude', 'settings.json'), '{"model":"opus"}');
    writeFileSync(join(untouchedHome, '.qwen', 'settings.json'), JSON.stringify({ theme: 'light', hooks: { Stop: { custom: 'yes' } } }, null, 4));
    const noopServer = http.createServer((_req, res) => { res.statusCode = 200; res.end(JSON.stringify({ ok: true })); });
    await new Promise<void>((resolve) => noopServer.listen(0, '127.0.0.1', resolve));
    await run('node', ['packages/walkie-cli/walkie.mjs', 'hook', '--tools', 'claude,qwen,droid', '--uninstall'], {
      env: { ...process.env, WALKIE_HOME: untouchedHome, WALKIE_URL: `http://127.0.0.1:${(noopServer.address() as AddressInfo).port}`, WALKIE_API_KEY: 'tok' }
    });
    expect(readFileSync(join(untouchedHome, '.claude', 'settings.json'), 'utf8')).toBe('{"model":"opus"}'); // 一字节不动
    const qwenAfter = JSON.parse(readFileSync(join(untouchedHome, '.qwen', 'settings.json'), 'utf8'));
    expect(qwenAfter.hooks.Stop).toEqual({ custom: 'yes' }); // 非数组事件值（未知 schema）原样保留
    expect(existsSync(join(untouchedHome, '.factory', 'hooks.json'))).toBe(false); // 从未装过 → 不凭空创建
    noopServer.close();
    rmSync(untouchedHome, { recursive: true, force: true });

    rmSync(home, { recursive: true, force: true });
    server.close();
  }, 30_000);

  it('installs the opencode plugin and removes it again', async () => {
    const server = http.createServer((_req, res) => { res.statusCode = 200; res.end(JSON.stringify({ ok: true })); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const home = mkdtempSync(join(tmpdir(), 'walkie-hook-oc-'));
    const cli = (extra: string[]) => run('node', ['packages/walkie-cli/walkie.mjs', 'hook', '--tools', 'opencode', ...extra], {
      env: { ...process.env, WALKIE_HOME: home, WALKIE_URL: `http://127.0.0.1:${port}`, WALKIE_API_KEY: 'tok' }
    });

    await cli([]);
    const pluginFile = join(home, '.config', 'opencode', 'plugin', 'walkie-notify.js');
    const plugin = readFileSync(pluginFile, 'utf8');
    expect(plugin).toContain('session.idle');
    expect(plugin).toContain('/api/v1/hooks/agent');
    expect(plugin).not.toContain('secret-key-xyz'); // 密钥只从环境变量读，绝不落盘

    await cli(['--uninstall']);
    expect(existsSync(pluginFile)).toBe(false);

    rmSync(home, { recursive: true, force: true });
    server.close();
  }, 30_000);

  it('detects agents by config dir and PATH, and --yes installs every detected one', async () => {
    const server = http.createServer((_req, res) => { res.statusCode = 200; res.end(JSON.stringify({ ok: true })); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const home = mkdtempSync(join(tmpdir(), 'walkie-hook-detect-'));
    mkdirSync(join(home, '.gemini'), { recursive: true });
    // 「装了但从没跑过」的工具没有配置目录，只能靠 PATH 上的可执行文件认出来
    const fakeBin = mkdtempSync(join(tmpdir(), 'walkie-fakebin-'));
    writeFileSync(join(fakeBin, process.platform === 'win32' ? 'droid.CMD' : 'droid'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    const env = {
      ...process.env,
      WALKIE_HOME: home,
      WALKIE_URL: `http://127.0.0.1:${port}`,
      WALKIE_API_KEY: 'tok',
      // 只留假 bin 目录（外加 node 自己所在目录，否则 spawn node 都找不到），
      // 免得把真机上装的 Agent 也探测进来
      PATH: `${fakeBin}${delimiter}${dirname(process.execPath)}`,
      Path: `${fakeBin}${delimiter}${dirname(process.execPath)}`
    };
    const cli = (args: string[]) => run('node', ['packages/walkie-cli/walkie.mjs', 'hook', ...args], { env });

    // --detect 不需要凭据，也绝不写盘
    const detected = await run('node', ['packages/walkie-cli/walkie.mjs', 'hook', '--detect'], { env: { ...env, WALKIE_URL: '', WALKIE_API_KEY: '' } });
    expect(detected.stdout).toContain('有配置目录'); // gemini
    expect(detected.stdout).toContain('命令在 PATH 上'); // droid
    expect(detected.stdout).toContain('推荐安装：gemini, droid');
    expect(existsSync(join(home, '.gemini', 'settings.json'))).toBe(false);

    // --yes：装全部探测到的（gemini + droid），不问问题
    const installed = await cli(['--yes']);
    expect(installed.stdout).toContain('已安装 2 个工具');
    expect(existsSync(join(home, '.gemini', 'settings.json'))).toBe(true);
    expect(existsSync(join(home, '.factory', 'hooks.json'))).toBe(true);

    // 重装报「更新」而不是「写入」——探测认得出自己装过的
    expect((await cli(['--yes'])).stdout).toContain('已更新');

    // --uninstall 不给 --tools 时，摘的是所有装过 walkie hooks 的工具
    expect((await cli(['--uninstall'])).stdout).toContain('已移除');
    expect((await cli(['--uninstall'])).stdout).not.toContain('已移除');

    rmSync(home, { recursive: true, force: true });
    rmSync(fakeBin, { recursive: true, force: true });
    server.close();
  }, 30_000);
});
