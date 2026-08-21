#!/usr/bin/env node
// walkie-notify — CLI for Walkie (#15): send notifications from CI (GitHub Actions) or the terminal.
//
//   walkie-notify send --url https://host --token <key> --to prod-alerts --title "..." --body "..."
//   walkie-notify status <deliveryId> --url https://host --token <key>
//   walkie-notify hook --url https://host --token <key>   # install Claude Code / Cursor hooks
//
// Zero dependencies, Node >= 22 (global fetch).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const VERSION = '0.3.0';

const USAGE = `walkie-notify — CLI for Walkie notifications

Usage:
  walkie-notify send [options]              Send a notification via POST /api/v1/notify
  walkie-notify status <deliveryId> [options]   Fetch delivery status via GET /api/v1/deliveries/<id>
  walkie-notify hook [options]              Install Claude Code / Cursor hooks in one command
  walkie-notify hook --uninstall            Remove the hooks this command installed
  walkie-notify --help | --version

Options for send:
  --url <url>          Walkie base URL, e.g. https://walkie.example.com
                       (default: $WALKIE_URL)
  --token <key>        Agent API key, sent as Bearer (default: $WALKIE_API_KEY)
  --to <destination>   Destination ID or slug (channel / route)
  --title <text>       Notification title (required)
  --body <text>        Notification body (required)
  --severity <level>   info | success | warning | critical (default: info)
  --tags <tags>        Pipe-separated tags, e.g. "ops|deploy"
  --link <url>         Notification link, rendered as the message's click target
  --idempotency-key <k>  Dedup key: retries with the same key return the original delivery
  --json               Print the full JSON response instead of just the delivery ID

Options for status:
  --url / --token / --json   Same as send

Options for hook:
  --url / --token      Same as send (the token is stored in the hook config via
                       an env var reference, never in plain text — see below)
  --destination <slug> Required when the key targets multiple destinations
  --scope user         Install for the current user (default): Claude Code settings.json
                       at ~/.claude/settings.json, Cursor at ~/.cursor/hooks.json
  --scope project      Install into .claude/settings.json / .cursor/hooks.json in cwd
  --tools claude,cursor  Comma list; default auto-detects (install wherever the
                       config directory exists; use --tools to force)
  --uninstall          Remove previously installed walkie hooks (same --scope)

Hook auth: Claude Code supports env-var interpolation in HTTP hook headers, so the
config references $WALKIE_TOKEN — set WALKIE_URL and WALKIE_TOKEN in your shell
profile. The Cursor forwarding script reads the same variables.

Exit codes: 0 success, 1 usage error, 2 API error (response body printed to stderr).

Example:
  walkie-notify send --url https://walkie.example.com --token rdk_xxx \\
    --to prod-alerts --title "Deploy failed" --body "v2.4.0 rollback executed" --severity critical
`;

const BOOLEAN_FLAGS = new Set(['help', 'h', 'version', 'v', 'json', 'uninstall']);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith('--')) {
      out._.push(raw);
      continue;
    }
    let key = raw.slice(2);
    let value;
    const eq = key.indexOf('=');
    if (eq !== -1) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else if (BOOLEAN_FLAGS.has(key)) {
      value = true;
    } else {
      value = argv[i + 1];
      i++;
    }
    out[key] = value;
  }
  return out;
}

function usageError(message) {
  process.stderr.write(`walkie-notify: ${message}\n\n${USAGE}`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const [command, ...rest] = args._;

if (args.help || args.h || args.version || args.v) {
  process.stdout.write(args.version || args.v ? `${VERSION}\n` : USAGE);
  process.exit(0);
}

const baseUrl = String(args.url ?? process.env.WALKIE_URL ?? '').trim().replace(/\/+$/, '');
const token = String(args.token ?? process.env.WALKIE_API_KEY ?? '').trim();
const severity = String(args.severity ?? 'info').toLowerCase();
const SEVERITIES = ['info', 'success', 'warning', 'critical'];

if (!command) usageError('missing command (send | status)');
if (!baseUrl) usageError('missing --url (or set WALKIE_URL)');
if (!token) usageError('missing --token (or set WALKIE_API_KEY)');

async function api(path, init) {
  let response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init?.headers ?? {}) }
    });
  } catch (error) {
    process.stderr.write(`walkie-notify: request failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    process.stderr.write(`walkie-notify: HTTP ${response.status}: ${text.slice(0, 2000)}\n`);
    process.exit(2);
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

if (command === 'send') {
  const destination = String(args.to ?? '').trim();
  const title = String(args.title ?? '');
  const body = String(args.body ?? '');
  const link = String(args.link ?? '');
  // --idempotency-key 落在 args['idempotency-key']；camelCase 别名一并接受
  const idempotencyKey = String(args['idempotency-key'] ?? args.idempotencyKey ?? '');
  if (!destination) usageError('missing --to <destination>');
  if (!title) usageError('missing --title');
  if (!body) usageError('missing --body');
  if (!SEVERITIES.includes(severity)) usageError(`invalid --severity "${severity}" (use ${SEVERITIES.join(' | ')})`);

  const payload = {
    destination,
    title,
    body,
    severity,
    ...(args.tags ? { tags: String(args.tags) } : {}),
    ...(link ? { url: link } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {})
  };

  const result = await api('/api/v1/notify', { method: 'POST', body: JSON.stringify(payload) });
  if (args.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(`${result.deliveryId ?? '(no deliveryId in response)'}\n`);
  }
  process.exit(0);
}

if (command === 'status') {
  const id = String(rest[0] ?? '').trim();
  if (!id) usageError('missing <deliveryId> argument');
  const result = await api(`/api/v1/deliveries/${encodeURIComponent(id)}`, { method: 'GET' });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(0);
}

/* ────────────────────────────────────────────────────────────
 * hook install / uninstall — Claude Code + Cursor 一键接入
 * ──────────────────────────────────────────────────────────── */

const WALKIE_HOOK_MARKER = 'installed-by-walkie';

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function isWalkieHandler(handler) {
  const url = typeof handler === 'object' && handler !== null ? String(handler.url ?? '') : '';
  return url.includes('/api/v1/hooks/claude');
}

/** 深合并 walkie hooks 进 Claude Code settings.json 的 hooks 字段；重复安装幂等 */
function mergeClaudeHooks(settings, hookConfig) {
  const hooks = { ...(settings.hooks ?? {}) };
  for (const [event, groups] of Object.entries(hookConfig)) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    // 清掉旧的 walkie 组（重装/换 URL 场景），保留用户其它 hook 组
    const kept = existing.filter((group) => !(Array.isArray(group?.hooks) && group.hooks.some(isWalkieHandler)));
    const matcher = groups.matcher;
    // 同 matcher 的组合并追加，避免同事件同 matcher 出现两组
    const same = matcher ? kept.find((group) => group?.matcher === matcher) : undefined;
    const handlers = Array.isArray(groups.hooks) ? groups.hooks : [groups.hooks];
    if (same) same.hooks = [...(same.hooks ?? []), ...handlers];
    else kept.push({ ...(matcher ? { matcher } : {}), hooks: handlers });
    hooks[event] = kept;
  }
  return { ...settings, hooks };
}

/** 从 Claude Code settings.json 移除 walkie handlers（组空了连组一起删） */
function stripClaudeHooks(settings) {
  if (!settings.hooks) return settings;
  const hooks = {};
  let removed = 0;
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept = (Array.isArray(groups) ? groups : [])
      .map((group) => ({ ...group, hooks: (group?.hooks ?? []).filter((handler) => { const hit = isWalkieHandler(handler); if (hit) removed++; return !hit; }) }))
      .filter((group) => (group.hooks ?? []).length > 0);
    if (kept.length) hooks[event] = kept;
  }
  stripClaudeHooks.removed = removed;
  return { ...settings, hooks };
}

const CURSOR_SCRIPT = `#!/bin/sh
# ${WALKIE_HOOK_MARKER} — Cursor hook → Walkie 转发；由 walkie-notify hook 生成，可随时删除
stdin_payload=$(cat)
url="\${WALKIE_URL:-}"
token="\${WALKIE_TOKEN:-}"
[ -z "$token" ] || [ -z "$url" ] && exit 0
curl -fsS --max-time 10 -X POST "$url/api/v1/hooks/claude\${WALKIE_DESTINATION:+?destination=$WALKIE_DESTINATION}" \\
  -H "authorization: Bearer $token" -H 'content-type: application/json' \\
  -d "$stdin_payload" >/dev/null 2>&1 || true
exit 0
`;

/** Cursor hooks.json 里 walkie 挂的事件（uninstall 时按此摘除） */
const CURSOR_EVENTS = ['stop', 'sessionEnd'];

function cursorHookEntries(scriptPath) {
  return {
    stop: [{ command: scriptPath, timeout: 15 }],
    sessionEnd: [{ command: scriptPath, timeout: 5 }]
  };
}

if (command === 'hook') {
  const uninstall = Boolean(args.uninstall);
  const scope = String(args.scope ?? 'user') === 'project' ? 'project' : 'user';
  const requested = String(args.tools ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  // Windows 上 os.homedir() 读注册表不看 $HOME；WALKIE_HOME 显式覆盖主要供测试与便携安装
  const base = scope === 'project' ? process.cwd() : (process.env.WALKIE_HOME || homedir());

  // 自动检测：默认只装已存在配置目录的工具（不无中生有）；--tools 可强制
  const claudePath = path.join(base, '.claude', 'settings.json');
  const cursorDir = path.join(base, '.cursor');
  const targets = [];
  const claudeExists = existsSync(path.dirname(claudePath));
  const cursorExists = existsSync(cursorDir);
  if (requested.length) {
    if (requested.includes('claude')) targets.push('claude');
    if (requested.includes('cursor')) targets.push('cursor');
  } else {
    if (claudeExists) targets.push('claude');
    if (cursorExists) targets.push('cursor');
    if (!targets.length) {
      process.stderr.write(`walkie-notify: 没找到 ~/.claude 或 ~/.cursor 配置目录。\n用 --tools claude 或 --tools cursor 强制创建，或先安装 Claude Code / Cursor。\n`);
      process.exit(1);
    }
  }

  if (uninstall) {
    if (targets.includes('claude')) {
      const settings = readJson(claudePath) ?? {};
      const stripped = stripClaudeHooks(settings);
      if (stripClaudeHooks.removed > 0) { writeJson(claudePath, stripped); process.stdout.write(`✓ Claude Code hooks 已移除（${stripClaudeHooks.removed} 个）\n`); }
      else process.stdout.write('· Claude Code：没有 walkie hooks\n');
    }
    if (targets.includes('cursor')) {
      const hooksFile = path.join(cursorDir, 'hooks.json');
      const scriptFile = path.join(cursorDir, 'hooks', 'walkie-notify.sh');
      const hooks = readJson(hooksFile);
      if (hooks && hooks.hooks) {
        // 只摘我们挂的事件里指向 walkie 脚本的条目；其它命令保留
        for (const event of CURSOR_EVENTS) {
          if (Array.isArray(hooks.hooks[event])) {
            hooks.hooks[event] = hooks.hooks[event].filter((entry) => !String(entry?.command ?? '').includes('walkie-notify.sh'));
            if (hooks.hooks[event].length === 0) delete hooks.hooks[event];
          }
        }
        writeJson(hooksFile, hooks);
      }
      if (existsSync(scriptFile)) { await import('node:fs').then((fs) => fs.rmSync(scriptFile)); process.stdout.write('✓ Cursor hooks 已移除\n'); }
      else process.stdout.write('· Cursor：没有 walkie hooks\n');
    }
    process.exit(0);
  }

  if (!baseUrl) usageError('missing --url (or set WALKIE_URL)');
  if (!token) usageError('missing --token (or set WALKIE_API_KEY)');
  const destination = String(args.destination ?? '').trim();
  const suffix = destination ? `?destination=${encodeURIComponent(destination)}` : '';

  // 先打一发真通知验证凭据+路由（别等用户跑完任务才发现配错）
  const probe = await fetch(`${baseUrl}/api/v1/hooks/claude${suffix}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: '✅ walkie hook 安装验证：收到这条说明配置正确。', cwd: process.cwd() })
  }).catch(() => null);
  if (!probe || !probe.ok) {
    const detail = probe ? await probe.text().catch(() => '') : 'network error';
    process.stderr.write(`walkie-notify: 验证失败（HTTP ${probe ? probe.status : 'n/a'}）: ${detail.slice(0, 300)}\n请检查 --url/--token${destination ? '' : '；若 key 绑定多个目的地需 --destination'}\n`);
    process.exit(2);
  }

  const httpHandler = {
    type: 'http',
    url: `${baseUrl}/api/v1/hooks/claude${suffix}`,
    headers: { Authorization: 'Bearer $WALKIE_TOKEN' },
    allowedEnvVars: ['WALKIE_TOKEN']
  };

  const claudeConfig = {
    Notification: { matcher: 'permission_prompt|idle_prompt|agent_needs_input|agent_completed', hooks: [httpHandler] },
    Stop: { hooks: [httpHandler] },
    StopFailure: { hooks: [httpHandler] }
  };

  if (targets.includes('claude')) {
    const settings = readJson(claudePath) ?? {};
    writeJson(claudePath, mergeClaudeHooks(settings, claudeConfig));
    process.stdout.write(`✓ Claude Code hooks 已写入 ${claudePath}\n`);
  }

  if (targets.includes('cursor')) {
    const scriptFile = path.join(cursorDir, 'hooks', 'walkie-notify.sh');
    mkdirSync(path.dirname(scriptFile), { recursive: true });
    writeFileSync(scriptFile, CURSOR_SCRIPT, { mode: 0o755 });
    const hooksFile = path.join(cursorDir, 'hooks.json');
    const hooks = readJson(hooksFile) ?? {};
    // hooks.json 结构兜底：旧版/手写文件可能只有 version 没有 hooks 键
    hooks.version = hooks.version ?? 1;
    hooks.hooks = hooks.hooks ?? {};
    const entries = cursorHookEntries(scriptFile);
    for (const [event, value] of Object.entries(entries)) hooks.hooks[event] = value;
    writeJson(hooksFile, hooks);
    process.stdout.write(`✓ Cursor hooks 已写入 ${hooksFile}（脚本 ${scriptFile}）\n`);
  }

  process.stdout.write(`
已安装。还需要在 shell 配置（~/.bashrc / ~/.zshrc / PowerShell $PROFILE）里导出：
  export WALKIE_URL="${baseUrl}"
  export WALKIE_TOKEN=<你的 Agent Key>
${destination ? `  export WALKIE_DESTINATION="${destination}"\n` : ''}
之后 Claude Code 在等你授权、任务完成、回合失败时，通知会推到你的目的地；
Cursor 在任务结束与会话异常时同样推送。卸载：walkie-notify hook --uninstall
`);
  process.exit(0);
}

usageError(`unknown command "${command}" (send | status | hook)`);
