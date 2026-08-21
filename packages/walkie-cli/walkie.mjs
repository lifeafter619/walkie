#!/usr/bin/env node
// walkie-notify — CLI for Walkie (#15): send notifications from CI (GitHub Actions) or the terminal.
//
//   walkie-notify send --url https://host --token <key> --to prod-alerts --title "..." --body "..."
//   walkie-notify status <deliveryId> --url https://host --token <key>
//   walkie-notify hook --url https://host --token <key>   # install Claude Code / Cursor hooks
//
// Zero dependencies, Node >= 22 (global fetch).

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  --only <level>       Only notify for events at or above the level:
                       critical (waiting for you / failures only — the quiet mode),
                       warning (+ tool failures), success (+ task completed),
                       info (everything, default). Changeable later via the
                       WALKIE_MIN_SEVERITY env var without reinstalling
  --scope user         Install for the current user (default): config files
                       under the home directory. --scope project installs
                       into .claude/ .cursor/ ... in the current directory
  --tools a,b,...      Limit tools: claude | cursor | codex | zcode | gemini
                       (default: auto-detect installed ones)
  --uninstall          Remove previously installed walkie hooks (same --scope)

Supported tools: Claude Code (native HTTP hooks), Cursor, Codex, ZCode and
Gemini CLI (command hooks + forwarding script). Desktop apps that ship the
same engines (Claude Desktop, Cursor desktop) share the config files.

Hook auth: the config references $WALKIE_TOKEN — set WALKIE_URL and
WALKIE_TOKEN in your shell profile. Command-hook tools read the same
variables via the forwarding script, which always exits 0 (never blocks
your workflow) and stays silent when unconfigured.

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
 * hook install / uninstall — 五家编码 Agent 工具一键接入
 *   claude  ~/.claude/settings.json       原生 type:"http" hook
 *   cursor  ~/.cursor/hooks.json          command hook + 转发脚本
 *   codex   ~/.codex/hooks.json           同 Cursor（事件同构）
 *   zcode   ~/.zcode/cli/config.json      hooks.events（需 enabled:true）
 *   gemini  ~/.gemini/settings.json       hooks.<Event>（command，stdin JSON）
 * ──────────────────────────────────────────────────────────── */

const WALKIE_HOOK_MARKER = 'installed-by-walkie';
const HOOK_ENDPOINT = '/api/v1/hooks/agent';
const SEVERITY_RANK = { info: 0, success: 1, warning: 2, critical: 3 };

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function isWalkieHandler(handler) {
  const url = typeof handler === 'object' && handler !== null ? String(handler.url ?? '') : '';
  return url.includes('/api/v1/hooks/');
}

/** 深合并 walkie hooks 进 Claude/Codex 式 settings 的 hooks 字段；重复安装幂等 */
function mergeHookGroups(settings, hookConfig, options = {}) {
  const hooks = { ...(settings.hooks ?? {}) };
  for (const [event, groups] of Object.entries(hookConfig)) {
    const existing = Array.isArray(hooks[event]) ? hooks[event] : [];
    const kept = existing.filter((group) => !(Array.isArray(group?.hooks) && group.hooks.some((entry) => options.match ? options.match(entry) : isWalkieHandler(entry))));
    const matcher = groups.matcher;
    const same = matcher ? kept.find((group) => group?.matcher === matcher) : undefined;
    const handlers = Array.isArray(groups.hooks) ? groups.hooks : [groups.hooks];
    if (same) same.hooks = [...(same.hooks ?? []), ...handlers];
    else kept.push({ ...(matcher ? { matcher } : {}), hooks: handlers });
    hooks[event] = kept;
  }
  return { ...settings, hooks };
}

function stripHookGroups(settings, options = {}) {
  if (!settings.hooks) { stripHookGroups.removed = 0; return settings; }
  const hooks = {};
  let removed = 0;
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept = (Array.isArray(groups) ? groups : [])
      .map((group) => ({ ...group, hooks: (group?.hooks ?? []).filter((entry) => { const hit = options.match ? options.match(entry) : isWalkieHandler(entry); if (hit) removed++; return !hit; }) }))
      .filter((group) => (group.hooks ?? []).length > 0);
    if (kept.length) hooks[event] = kept;
  }
  stripHookGroups.removed = removed;
  return { ...settings, hooks };
}

/** 转发脚本：读 stdin JSON → POST 到 hook 端点。永远 exit 0（不阻塞工作流）。
 *  min_severity 编码进 URL——用户/Agent 改这行即改通知条件，不动服务端 */
function forwardScript(minSeverity) {
  const query = `\${WALKIE_DESTINATION:+?destination=$WALKIE_DESTINATION}`;
  const levelQuery = minSeverity ? `&min_severity=${minSeverity}` : `\${WALKIE_MIN_SEVERITY:+&min_severity=$WALKIE_MIN_SEVERITY}`;
  return `#!/bin/sh
# ${WALKIE_HOOK_MARKER} — agent hook → Walkie 转发；由 walkie-notify hook 生成，可随时删除
stdin_payload=$(cat)
url="\${WALKIE_URL:-}"
token="\${WALKIE_TOKEN:-}"
[ -z "$token" ] || [ -z "$url" ] && exit 0
curl -fsS --max-time 10 -X POST "$url${HOOK_ENDPOINT}${query}${levelQuery}" \\
  -H "authorization: Bearer $token" -H 'content-type: application/json' \\
  -d "$stdin_payload" >/dev/null 2>&1 || true
exit 0
`;
}

const SCRIPT_NAME = 'walkie-notify.sh';
const isScriptEntry = (entry) => typeof entry === 'object' && entry !== null && String(entry.command ?? '').includes(SCRIPT_NAME);

if (command === 'hook') {
  const uninstall = Boolean(args.uninstall);
  const scope = String(args.scope ?? 'user') === 'project' ? 'project' : 'user';
  const requested = String(args.tools ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  const only = String(args.only ?? '').toLowerCase();
  // --only critical = 只推送关键（等你操作/失败）；warning = 加上工具失败；success = 再加任务完成；info = 全部
  const minSeverity = only ? (SEVERITIES.includes(only) ? only : null) : undefined;
  if (only && minSeverity === null) usageError(`invalid --only "${only}" (use ${SEVERITIES.join(' | ')})`);
  // Windows 上 os.homedir() 读注册表不看 $HOME；WALKIE_HOME 显式覆盖主要供测试与便携安装
  const base = scope === 'project' ? process.cwd() : (process.env.WALKIE_HOME || homedir());

  const dirs = {
    claude: path.join(base, '.claude'),
    cursor: path.join(base, '.cursor'),
    codex: path.join(base, '.codex'),
    zcode: path.join(base, '.zcode', 'cli'),
    gemini: path.join(base, '.gemini')
  };
  const KNOWN_TOOLS = Object.keys(dirs);
  for (const tool of requested) {
    if (!KNOWN_TOOLS.includes(tool)) usageError(`unknown tool "${tool}" (use ${KNOWN_TOOLS.join(' | ')})`);
  }

  // 自动检测：默认只装已存在配置目录的工具（不无中生有）；--tools 可强制
  const targets = requested.length ? requested : KNOWN_TOOLS.filter((tool) => existsSync(dirs[tool]));
  if (!targets.length) {
    process.stderr.write(`walkie-notify: 没找到任何已知工具的配置目录（${KNOWN_TOOLS.join('/')}）。\n用 --tools <name> 强制创建，或先安装对应工具。\n`);
    process.exit(1);
  }

  if (uninstall) {
    const removeScript = (scriptFile, label) => {
      if (existsSync(scriptFile)) { rmSync(scriptFile); process.stdout.write(`✓ ${label} hooks 已移除\n`); }
      else process.stdout.write(`· ${label}：没有 walkie hooks\n`);
    };
    for (const tool of targets) {
      if (tool === 'claude') {
        const file = path.join(dirs.claude, 'settings.json');
        const settings = readJson(file) ?? {};
        const stripped = stripHookGroups(settings);
        if (stripHookGroups.removed > 0) { writeJson(file, stripped); process.stdout.write(`✓ Claude Code hooks 已移除（${stripHookGroups.removed} 个）\n`); }
        else process.stdout.write('· Claude Code：没有 walkie hooks\n');
      } else if (tool === 'cursor' || tool === 'codex') {
        const label = tool === 'cursor' ? 'Cursor' : 'Codex';
        const hooksFile = path.join(dirs[tool], 'hooks.json');
        const hooks = readJson(hooksFile);
        if (hooks && hooks.hooks) {
          for (const event of Object.keys(hooks.hooks)) {
            if (Array.isArray(hooks.hooks[event])) {
              hooks.hooks[event] = hooks.hooks[event].filter((entry) => !isScriptEntry(entry));
              if (hooks.hooks[event].length === 0) delete hooks.hooks[event];
            }
          }
          writeJson(hooksFile, hooks);
        }
        removeScript(path.join(dirs[tool], 'hooks', SCRIPT_NAME), label);
      } else if (tool === 'zcode') {
        // ZCode：hooks.events 结构 + enabled 开关；摘除后组空了关掉 enabled（若用户没有别的 hooks）
        const file = path.join(dirs.zcode, 'config.json');
        const config = readJson(file) ?? {};
        const events = config.hooks?.events;
        if (events) {
          for (const event of Object.keys(events)) {
            if (Array.isArray(events[event])) {
              events[event] = events[event].filter((entry) => !(Array.isArray(entry?.hooks) && entry.hooks.some(isScriptEntry)));
              if (events[event].length === 0) delete events[event];
            }
          }
          if (Object.keys(events).length === 0) {
            delete config.hooks.events;
            // 剩下的只有我们自己写的 enabled:true 时连 hooks 块一起清掉；
            // 用户自设的 timeoutMs/maxOutputBytes 等其它键原样保留
            const rest = Object.keys(config.hooks).filter((key) => key !== 'enabled');
            if (rest.length === 0) delete config.hooks;
          }
        }
        writeJson(file, config);
        removeScript(path.join(dirs.zcode, 'hooks', SCRIPT_NAME), 'ZCode');
      } else if (tool === 'gemini') {
        const file = path.join(dirs.gemini, 'settings.json');
        const settings = readJson(file) ?? {};
        const stripped = stripHookGroups(settings, { match: isScriptEntry });
        if (stripHookGroups.removed > 0) { writeJson(file, stripped); process.stdout.write(`✓ Gemini CLI hooks 已移除（${stripHookGroups.removed} 个）\n`); }
        else process.stdout.write('· Gemini CLI：没有 walkie hooks\n');
        removeScript(path.join(dirs.gemini, 'hooks', SCRIPT_NAME), 'Gemini CLI');
      }
    }
    process.exit(0);
  }

  if (!baseUrl) usageError('missing --url (or set WALKIE_URL)');
  if (!token) usageError('missing --token (or set WALKIE_API_KEY)');
  const destination = String(args.destination ?? '').trim();
  const query = [
    ...(destination ? [`destination=${encodeURIComponent(destination)}`] : []),
    ...(minSeverity ? [`min_severity=${minSeverity}`] : [])
  ].join('&');

  // 先打一发真通知验证凭据+路由（别等用户跑完任务才发现配错）
  const probe = await fetch(`${baseUrl}${HOOK_ENDPOINT}${query ? `?${query}` : ''}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: `✅ walkie hook 安装验证（级别 ${minSeverity ?? '全部'}）：收到这条说明配置正确。`, cwd: process.cwd() })
  }).catch(() => null);
  if (!probe || !probe.ok) {
    const detail = probe ? await probe.text().catch(() => '') : 'network error';
    process.stderr.write(`walkie-notify: 验证失败（HTTP ${probe ? probe.status : 'n/a'}）: ${detail.slice(0, 300)}\n请检查 --url/--token${destination ? '' : '；若 key 绑定多个目的地需 --destination'}\n`);
    process.exit(2);
  }

  const installScript = (scriptFile) => {
    mkdirSync(path.dirname(scriptFile), { recursive: true });
    writeFileSync(scriptFile, forwardScript(minSeverity), { mode: 0o755 });
    return scriptFile;
  };
  // --only 未指定时脚本里留 WALKIE_MIN_SEVERITY 钩子：用户之后改环境变量即可改条件
  const installedEvents = [];

  for (const tool of targets) {
    if (tool === 'claude') {
      const file = path.join(dirs.claude, 'settings.json');
      const urlQuery = query ? `?${query}` : '';
      const httpHandler = {
        type: 'http',
        url: `${baseUrl}${HOOK_ENDPOINT}${urlQuery}`,
        headers: { Authorization: 'Bearer $WALKIE_TOKEN' },
        allowedEnvVars: ['WALKIE_TOKEN']
      };
      const config = {
        Notification: { matcher: 'permission_prompt|idle_prompt|agent_needs_input|agent_completed', hooks: [httpHandler] },
        Stop: { hooks: [httpHandler] },
        StopFailure: { hooks: [httpHandler] }
      };
      writeJson(file, mergeHookGroups(readJson(file) ?? {}, config));
      process.stdout.write(`✓ Claude Code hooks 已写入 ${file}\n`);
      installedEvents.push('Claude Code：等你授权 / 任务完成 / 回合失败');
    } else if (tool === 'cursor' || tool === 'codex') {
      const label = tool === 'cursor' ? 'Cursor' : 'Codex';
      const scriptFile = installScript(path.join(dirs[tool], 'hooks', SCRIPT_NAME));
      const hooksFile = path.join(dirs[tool], 'hooks.json');
      const hooks = readJson(hooksFile) ?? {};
      hooks.version = hooks.version ?? 1;
      hooks.hooks = hooks.hooks ?? {};
      hooks.hooks.stop = [{ command: scriptFile, timeout: 15 }];
      hooks.hooks.sessionEnd = [{ command: scriptFile, timeout: 5 }];
      writeJson(hooksFile, hooks);
      process.stdout.write(`✓ ${label} hooks 已写入 ${hooksFile}（脚本 ${scriptFile}）\n`);
      installedEvents.push(`${label}：任务结束（status=error → critical）/ 会话异常`);
    } else if (tool === 'zcode') {
      // ZCode 只有 7 个事件，没有 Notification——Stop 是「回合结束」，PostToolUseFailure 兜失败告警
      const scriptFile = installScript(path.join(dirs.zcode, 'hooks', SCRIPT_NAME));
      const file = path.join(dirs.zcode, 'config.json');
      const config = readJson(file) ?? {};
      const hooksBlock = config.hooks ?? {};
      const events = hooksBlock.events ?? {};
      const entry = { hooks: [{ type: 'command', command: JSON.stringify(scriptFile).slice(1, -1), timeout: 15 }] };
      events.Stop = [...(Array.isArray(events.Stop) ? events.Stop.filter((group) => !(Array.isArray(group?.hooks) && group.hooks.some(isScriptEntry))) : []), entry];
      events.PostToolUseFailure = [...(Array.isArray(events.PostToolUseFailure) ? events.PostToolUseFailure.filter((group) => !(Array.isArray(group?.hooks) && group.hooks.some(isScriptEntry))) : []), entry];
      // 配置文件 hooks 默认不启用；walkie 依赖它必须打开（已有 hooks 时不关用户配置）
      config.hooks = { ...hooksBlock, enabled: true, events };
      writeJson(file, config);
      process.stdout.write(`✓ ZCode hooks 已写入 ${file}（hooks.enabled=true）\n`);
      installedEvents.push('ZCode：回合结束 / 工具调用失败');
    } else if (tool === 'gemini') {
      const scriptFile = installScript(path.join(dirs.gemini, 'hooks', SCRIPT_NAME));
      const file = path.join(dirs.gemini, 'settings.json');
      const config = {
        AfterAgent: { hooks: [{ type: 'command', command: scriptFile, timeout: 15000 }] },
        Notification: { hooks: [{ type: 'command', command: scriptFile, timeout: 15000 }] }
      };
      writeJson(file, mergeHookGroups(readJson(file) ?? {}, config, { match: isScriptEntry }));
      process.stdout.write(`✓ Gemini CLI hooks 已写入 ${file}\n`);
      installedEvents.push('Gemini CLI：回合结束（AfterAgent）/ 系统提示（Notification）');
    }
  }

  const levelNote = minSeverity
    ? `\n通知级别：仅推送 ${minSeverity} 及以上（等你操作与失败=critical、工具失败=warning、任务完成=success、轻提示=info）。`
    : `\n通知级别：默认全部推送。想只收关键信息，重装时加 --only critical|warning|success，
或设环境变量 WALKIE_MIN_SEVERITY（脚本会读取）。`;
  process.stdout.write(`
已安装 ${targets.length} 个工具的 hooks。还需要在 shell 配置（~/.bashrc / ~/.zshrc / PowerShell $PROFILE）里导出：
  export WALKIE_URL="${baseUrl}"
  export WALKIE_TOKEN=<你的 Agent Key>
${destination ? `  export WALKIE_DESTINATION="${destination}"\n` : ''}
触发时机：
${installedEvents.map((line) => `  · ${line}`).join('\n')}${levelNote}
卸载：walkie-notify hook --uninstall${targets.length < KNOWN_TOOLS.length ? '（或 --tools <name> 指定单一工具）' : ''}
`);
  process.exit(0);
}

usageError(`unknown command "${command}" (send | status | hook)`);
