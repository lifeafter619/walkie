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
  walkie-notify hook [options]              Detect installed coding agents and install their hooks
  walkie-notify hook --detect               Only report what is installed on this machine
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
  --tools a,b,...      Limit tools: claude | cursor | codex | qwen | gemini |
                       droid | zcode | opencode
                       (default: probe the machine and ask which to install)
  --detect             Report detected agents and exit; writes nothing, no token needed
  --yes                Skip the prompt and install every detected agent
  --uninstall          Remove previously installed walkie hooks (same --scope)

Detection looks at each tool's config directory and at its executable on PATH,
so an agent that is installed but never launched is still found and offered.

Supported tools: Claude Code (native HTTP hooks), Codex, Qwen Code, Gemini CLI,
Droid (Factory), ZCode, Cursor (command hooks + forwarding script) and opencode
(generated plugin). Desktop apps that ship the same engines (Claude Desktop,
Cursor desktop, ZCode desktop) share the same config files.

Hook auth: the config references $WALKIE_TOKEN — set WALKIE_URL and
WALKIE_TOKEN in your shell profile. Command-hook tools read the same
variables via the forwarding script, which always exits 0 (never blocks
your workflow) and stays silent when unconfigured.

Exit codes: 0 success, 1 usage error, 2 API error (response body printed to stderr).

Example:
  walkie-notify send --url https://walkie.example.com --token rdk_xxx \\
    --to prod-alerts --title "Deploy failed" --body "v2.4.0 rollback executed" --severity critical
`;

const BOOLEAN_FLAGS = new Set(['help', 'h', 'version', 'v', 'json', 'uninstall', 'detect', 'yes', 'y']);

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

if (!command) usageError('missing command (send | status | hook)');
// hook --detect / --uninstall 只动本地文件，不需要凭据
const needsCredentials = !(command === 'hook' && (args.detect || args.uninstall));
if (needsCredentials && !baseUrl) usageError('missing --url (or set WALKIE_URL)');
if (needsCredentials && !token) usageError('missing --token (or set WALKIE_API_KEY)');

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
 * hook install / uninstall — 八家编码 Agent 工具一键接入
 *
 * 两种 schema，一套写入器：
 *   A. Claude 式嵌套（事件 → matcher 组 → handler 数组）
 *      claude   ~/.claude/settings.json      hooks.<Event>，原生 type:"http"
 *      codex    ~/.codex/hooks.json          hooks.<Event>，command（timeout 秒）
 *      qwen     ~/.qwen/settings.json        hooks.<Event>，command
 *      gemini   ~/.gemini/settings.json      hooks.<Event>，command（timeout 毫秒）
 *      droid    ~/.factory/hooks.json        事件在顶层，无 hooks 包装
 *      zcode    ~/.zcode/cli/config.json     hooks.events.<Event> + hooks.enabled
 *   B. Cursor 式扁平
 *      cursor   ~/.cursor/hooks.json         hooks.<event>: [{command,timeout}]
 *   C. 插件式
 *      opencode ~/.config/opencode/plugin/walkie.js   event: session.idle 等
 *
 * 桌面版与 CLI 共用同一批配置文件（Claude Desktop、Cursor 桌面版、ZCode 桌面版）。
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

const SCRIPT_NAME = 'walkie-notify.sh';
/** walkie 自己写的 handler：http 指向 hook 端点，command 指向转发脚本 */
function isWalkieHandler(handler) {
  if (typeof handler !== 'object' || handler === null) return false;
  return String(handler.url ?? '').includes('/api/v1/hooks/') || String(handler.command ?? '').includes(SCRIPT_NAME);
}

/** 在 root 的 path（如 ['hooks','events']）位置读出事件表并交给 fn 改写，返回新 root */
function atPath(root, keys, fn) {
  if (!keys.length) return fn(root ?? {});
  const [head, ...rest] = keys;
  const child = root?.[head] && typeof root[head] === 'object' ? root[head] : {};
  return { ...root, [head]: atPath(child, rest, fn) };
}

/** 合并 walkie 的事件组进 Claude 式事件表；先摘旧的再加，所以重复安装幂等 */
function mergeHookGroups(events, hookConfig) {
  const merged = { ...events };
  for (const [event, group] of Object.entries(hookConfig)) {
    const existing = Array.isArray(merged[event]) ? merged[event] : [];
    const kept = existing.filter((item) => !(Array.isArray(item?.hooks) && item.hooks.some(isWalkieHandler)));
    const handlers = Array.isArray(group.hooks) ? group.hooks : [group.hooks];
    kept.push({ ...(group.matcher ? { matcher: group.matcher } : {}), hooks: handlers });
    merged[event] = kept;
  }
  return merged;
}

/** 反操作：摘掉 walkie 的 handler，组空了删组、事件空了删事件；用户自己的 hooks 原样。
 *  非数组的键（未知 schema 的配置项）原样保留——卸载不能删用户没让删的东西 */
function stripHookGroups(events) {
  const kept = {};
  let removed = 0;
  for (const [event, groups] of Object.entries(events ?? {})) {
    if (!Array.isArray(groups)) { kept[event] = groups; continue; }
    const rest = groups
      .map((group) => ({ ...group, hooks: (group?.hooks ?? []).filter((entry) => { const hit = isWalkieHandler(entry); if (hit) removed++; return !hit; }) }))
      .filter((group) => (group.hooks ?? []).length > 0);
    if (rest.length) kept[event] = rest;
  }
  stripHookGroups.removed = removed;
  return kept;
}

/** 转发脚本：读 stdin JSON → POST 到 hook 端点。永远 exit 0（不阻塞工作流）。
 *  min_severity 编码进 URL——用户/Agent 改这行即改通知条件，不动服务端。
 *  查询串在 shell 里逐段拼：${q:+$q&} 是 POSIX 展开（q 非空补 &），最后
 *  ${query:+?$query} 统一补 ?——min_severity 不再依赖 destination 先出现 */
function forwardScript(minSeverity) {
  const levelLine = minSeverity
    ? `query="\${query:+\$query&}min_severity=${minSeverity}"`
    : `[ -n "\${WALKIE_MIN_SEVERITY:-}" ] && query="\${query:+\$query&}min_severity=\$WALKIE_MIN_SEVERITY"`;
  return `#!/bin/sh
# ${WALKIE_HOOK_MARKER} — agent hook → Walkie 转发；由 walkie-notify hook 生成，可随时删除
stdin_payload=$(cat)
url="\${WALKIE_URL:-}"
token="\${WALKIE_TOKEN:-}"
[ -z "$token" ] || [ -z "$url" ] && exit 0
query=""
[ -n "\${WALKIE_DESTINATION:-}" ] && query="destination=\$WALKIE_DESTINATION"
${levelLine}
curl -fsS --max-time 10 -X POST "$url${HOOK_ENDPOINT}\${query:+?\$query}" \\
  -H "authorization: Bearer $token" -H 'content-type: application/json' \\
  -d "$stdin_payload" >/dev/null 2>&1 || true
exit 0
`;
}

const isScriptEntry = (entry) => typeof entry === 'object' && entry !== null && String(entry.command ?? '').includes(SCRIPT_NAME);

/** opencode 没有 hooks 配置文件，只有插件；插件里直接 fetch 到同一个端点 */
function opencodePlugin(minSeverity) {
  return `// ${WALKIE_HOOK_MARKER} — opencode 插件 → Walkie 转发；由 walkie-notify hook 生成，可随时删除
const MIN_SEVERITY = ${minSeverity ? JSON.stringify(minSeverity) : 'process.env.WALKIE_MIN_SEVERITY'};

export const WalkieNotify = async ({ directory }) => {
  const post = async (payload) => {
    const url = process.env.WALKIE_URL;
    const token = process.env.WALKIE_TOKEN;
    if (!url || !token) return;
    const query = new URLSearchParams();
    if (process.env.WALKIE_DESTINATION) query.set('destination', process.env.WALKIE_DESTINATION);
    if (MIN_SEVERITY) query.set('min_severity', MIN_SEVERITY);
    const suffix = query.toString() ? '?' + query.toString() : '';
    try {
      await fetch(url.replace(/\\/+$/, '') + '${HOOK_ENDPOINT}' + suffix, {
        method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
        body: JSON.stringify({ cwd: directory, ...payload })
      });
    } catch {
      // 通知失败绝不影响会话
    }
  };
  return {
    event: async ({ event }) => {
      if (event.type === 'session.idle') await post({ hook_event_name: 'Stop' });
      if (event.type === 'session.error') await post({ hook_event_name: 'StopFailure', error: String(event.properties?.error?.name ?? 'session error') });
      if (event.type === 'permission.updated') await post({ hook_event_name: 'PermissionRequest' });
    }
  };
};
`;
}

/**
 * 工具表。shape 决定写法：
 *   nested = Claude 式（事件 → 组 → handler），container 指出事件表在文件里的位置
 *   flat   = Cursor 式（事件 → [{command,timeout}]）
 *   plugin = opencode（写一个 JS 插件文件）
 * events 用「服务端认识的事件名」——各家 schema 不同但事件语义同构，服务端统一归一化。
 * bin 是可执行文件名，用于探测「装了但还没跑过（配置目录还不存在）」的工具。
 */
const TOOLS = {
  claude: {
    label: 'Claude Code', shape: 'nested', dir: ['.claude'], file: 'settings.json', container: ['hooks'], handler: 'http',
    bin: ['claude'],
    // matcher 省略 = 所有通知类型都发；auth_success 之类服务端会丢弃
    events: ['Notification', 'Stop', 'StopFailure'], note: '等你授权 / 任务完成 / 回合失败'
  },
  codex: {
    label: 'Codex', shape: 'nested', dir: ['.codex'], file: 'hooks.json', container: ['hooks'], timeout: 15,
    bin: ['codex'],
    events: ['Stop', 'PermissionRequest'], note: '任务完成 / 等你批准'
  },
  qwen: {
    label: 'Qwen Code', shape: 'nested', dir: ['.qwen'], file: 'settings.json', container: ['hooks'], timeout: 15,
    bin: ['qwen'],
    events: ['Stop', 'Notification', 'PermissionRequest'], note: '任务完成 / 等你操作'
  },
  gemini: {
    label: 'Gemini CLI', shape: 'nested', dir: ['.gemini'], file: 'settings.json', container: ['hooks'], timeout: 15000,
    bin: ['gemini'],
    events: ['AfterAgent', 'Notification'], note: '回合结束 / 系统提示'
  },
  droid: {
    // Factory Droid：hooks.json 里事件直接在顶层，没有 hooks 包装层
    label: 'Droid (Factory)', shape: 'nested', dir: ['.factory'], file: 'hooks.json', container: [], timeout: 15,
    bin: ['droid'],
    events: ['Stop', 'Notification'], note: '任务完成 / 等你操作'
  },
  zcode: {
    // ZCode 的 hooks 默认关闭，且事件名是严格白名单——写错一个整份 hooks 会被静默丢弃
    label: 'ZCode', shape: 'nested', dir: ['.zcode', 'cli'], file: 'config.json', container: ['hooks', 'events'], timeout: 15, enable: true,
    bin: ['zcode'],
    events: ['Stop', 'PermissionRequest', 'PostToolUseFailure'], note: '回合结束 / 等你批准 / 工具失败'
  },
  cursor: {
    label: 'Cursor', shape: 'flat', dir: ['.cursor'], file: 'hooks.json',
    bin: ['cursor', 'cursor-agent'],
    events: { stop: 15, sessionEnd: 5 }, note: '任务结束（status=error → critical）/ 会话异常'
  },
  opencode: {
    label: 'opencode', shape: 'plugin', dir: ['.config', 'opencode', 'plugin'], projectDir: ['.opencode', 'plugin'], file: 'walkie-notify.js',
    bin: ['opencode'],
    note: '会话空闲（任务完成）/ 会话错误 / 权限请求'
  }
};

/** 可执行文件在 PATH 上？——只扫目录不执行任何东西（Windows 上带 PATHEXT） */
function onPath(names) {
  const dirs = String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? String(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : [''];
  return names.some((name) => dirs.some((dir) => exts.some((ext) => existsSync(path.join(dir, name + ext)))));
}

/** 一行问答；非 TTY 直接返回默认值（CI 里绝不卡住） */
function ask(question, fallback = '') {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return Promise.resolve(fallback);
  return new Promise((resolve) => {
    process.stdout.write(question);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.once('data', (chunk) => {
      process.stdin.pause();
      resolve(String(chunk).trim());
    });
  });
}


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

  const KNOWN_TOOLS = Object.keys(TOOLS);
  const toolDir = (name) => {
    const tool = TOOLS[name];
    return path.join(base, ...(scope === 'project' && tool.projectDir ? tool.projectDir : tool.dir));
  };
  const configFile = (name) => path.join(toolDir(name), TOOLS[name].file);
  // 检测按「工具的顶层配置目录」判断（.zcode/cli 的存在性看 .zcode，插件目录看 .config/opencode）
  const detectDir = (name) => {
    const tool = TOOLS[name];
    const dir = scope === 'project' && tool.projectDir ? tool.projectDir : tool.dir;
    return path.join(base, ...(name === 'opencode' && scope === 'user' ? dir.slice(0, 2) : [dir[0]]));
  };
  const scriptFileFor = (name) => path.join(toolDir(name), 'hooks', SCRIPT_NAME);

  for (const tool of requested) {
    if (!KNOWN_TOOLS.includes(tool)) usageError(`unknown tool "${tool}" (use ${KNOWN_TOOLS.join(' | ')})`);
  }

  /** 探测：配置目录在？可执行文件在 PATH 上？walkie hooks 已经装过了？ */
  function detect(name) {
    const tool = TOOLS[name];
    const configured = existsSync(detectDir(name));
    // --scope project 时 PATH 上有没有这个 CLI 说明不了本仓库要不要装，只看目录
    const installed = scope === 'user' && Array.isArray(tool.bin) ? onPath(tool.bin) : false;
    let hooked = false;
    if (tool.shape === 'plugin') hooked = existsSync(configFile(name));
    else hooked = JSON.stringify(readJson(configFile(name)) ?? {}).includes('/api/v1/hooks/') || existsSync(scriptFileFor(name));
    return { name, label: tool.label, configured, installed, hooked, detected: configured || installed };
  }

  const report = KNOWN_TOOLS.map(detect);
  const statusOf = (item) => item.hooked ? '已装 walkie hooks' : item.configured ? '已检测到（有配置目录）' : item.installed ? '已检测到（命令在 PATH 上）' : '未检测到';
  const printReport = () => {
    process.stdout.write(`\n本机探测到的编码 Agent（${scope === 'project' ? '项目作用域：' + process.cwd() : '用户作用域：' + base}）：\n`);
    report.forEach((item, index) => {
      const mark = item.hooked ? '✓' : item.detected ? '•' : '·';
      process.stdout.write(`  ${mark} ${String(index + 1).padStart(2)}. ${item.label.padEnd(16)} ${statusOf(item)}\n`);
    });
  };

  // --detect：只报告不写盘
  if (args.detect) {
    printReport();
    const found = report.filter((item) => item.detected).map((item) => item.name);
    process.stdout.write(found.length
      ? `\n推荐安装：${found.join(', ')}\n执行：walkie-notify hook --url <url> --token <key>${args.only ? ` --only ${only}` : ''}\n`
      : '\n没探测到已知工具。装好任一 Agent 后重跑，或用 --tools <name> 强制写入。\n');
    process.exit(0);
  }

  const recommended = report.filter((item) => item.detected).map((item) => item.name);
  let targets = requested;

  if (!targets.length && !uninstall && !args.yes && !args.y) {
    printReport();
    if (!recommended.length) {
      process.stderr.write(`\nwalkie-notify: 没探测到任何已知工具（配置目录与 PATH 都没有）。\n用 --tools <name> 强制创建，或先安装对应工具。\n`);
      process.exit(1);
    }
    process.stdout.write(`\n推荐安装：${recommended.map((name) => TOOLS[name].label).join('、')}\n`);
    const answer = await ask('回车=装推荐的 / 输入序号（如 1,3）/ a=全部 / q=退出：', '');
    if (answer.toLowerCase() === 'q') { process.stdout.write('已取消，什么都没写。\n'); process.exit(0); }
    if (answer.toLowerCase() === 'a') targets = KNOWN_TOOLS;
    else if (answer) {
      const picked = answer.split(/[,\s]+/).filter(Boolean).map((token) => {
        const index = Number(token);
        if (Number.isInteger(index) && index >= 1 && index <= report.length) return report[index - 1].name;
        if (KNOWN_TOOLS.includes(token)) return token;
        usageError(`看不懂的选择 "${token}"（用序号 1-${report.length} 或工具名）`);
        return null;
      });
      targets = [...new Set(picked)];
    } else targets = recommended;
  }

  // 卸载摘的是「装过 walkie hooks 的工具」；安装（--yes / 非交互）只碰探测到的
  if (!targets.length) {
    targets = uninstall ? report.filter((item) => item.hooked).map((item) => item.name) : recommended;
  }
  if (!targets.length) {
    process.stderr.write(uninstall
      ? 'walkie-notify: 没有任何工具装着 walkie hooks，无需卸载。\n'
      : `walkie-notify: 没找到任何已知工具（${KNOWN_TOOLS.join('/')}）。\n用 --tools <name> 强制创建，或先安装对应工具。\n`);
    process.exit(uninstall ? 0 : 1);
  }

  if (uninstall) {
    // 孤儿脚本（配置没了、脚本还在）也是 walkie 痕迹，一并摘掉
    const removeScript = (name) => {
      const scriptFile = scriptFileFor(name);
      if (!existsSync(scriptFile)) return false;
      rmSync(scriptFile);
      return true;
    };
    for (const name of targets) {
      const tool = TOOLS[name];
      const file = configFile(name);
      let removed = 0;
      if (tool.shape === 'nested') {
        const config = readJson(file);
        if (config && typeof config === 'object') {
          let next = atPath(config, tool.container, (events) => stripHookGroups(events));
          removed = stripHookGroups.removed;
          // 没摘到任何 handler 就一个字节都不写——不能凭空创建文件或重排用户配置。
          // 事件表空了才把容器键也清掉（ZCode 的 hooks.enabled 是我们打开的，一并收回）
          if (removed > 0) {
            if (tool.container.length && Object.keys(next.hooks?.events ?? next.hooks ?? {}).length === 0) {
              const rest = Object.keys(next.hooks ?? {}).filter((key) => key !== 'enabled' && key !== 'events');
              if (rest.length === 0) { next = { ...next }; delete next.hooks; }
              else { next = { ...next, hooks: { ...next.hooks } }; delete next.hooks.events; }
            }
            writeJson(file, next);
          }
        }
        if (removeScript(name)) removed++;
      } else if (tool.shape === 'flat') {
        const config = readJson(file);
        if (config?.hooks) {
          for (const event of Object.keys(config.hooks)) {
            if (!Array.isArray(config.hooks[event])) continue;
            const before = config.hooks[event].length;
            config.hooks[event] = config.hooks[event].filter((entry) => !isScriptEntry(entry));
            removed += before - config.hooks[event].length;
            if (config.hooks[event].length === 0) delete config.hooks[event];
          }
          if (removed > 0) writeJson(file, config);
        }
        if (removeScript(name)) removed++;
      } else if (tool.shape === 'plugin') {
        if (existsSync(file)) { rmSync(file); removed = 1; }
      }
      process.stdout.write(removed > 0 ? `✓ ${tool.label} hooks 已移除（${removed} 个）\n` : `· ${tool.label}：没有 walkie hooks\n`);
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

  const installScript = (name) => {
    const scriptFile = scriptFileFor(name);
    mkdirSync(path.dirname(scriptFile), { recursive: true });
    writeFileSync(scriptFile, forwardScript(minSeverity), { mode: 0o755 });
    return scriptFile;
  };
  // --only 未指定时脚本里留 WALKIE_MIN_SEVERITY 钩子：用户之后改环境变量即可改条件
  const installedEvents = [];

  for (const name of targets) {
    const tool = TOOLS[name];
    const file = configFile(name);
    if (tool.shape === 'nested') {
      const handler = tool.handler === 'http'
        ? {
            type: 'http',
            url: `${baseUrl}${HOOK_ENDPOINT}${query ? `?${query}` : ''}`,
            headers: { Authorization: 'Bearer $WALKIE_TOKEN' },
            allowedEnvVars: ['WALKIE_TOKEN']
          }
        : { type: 'command', command: JSON.stringify(installScript(name)).slice(1, -1), timeout: tool.timeout };
      const hookConfig = Object.fromEntries(tool.events.map((event) => [event, { hooks: [handler] }]));
      let config = atPath(readJson(file) ?? {}, tool.container, (events) => mergeHookGroups(events, hookConfig));
      // ZCode 的 hooks 默认不启用，walkie 依赖它必须打开
      if (tool.enable) config = { ...config, hooks: { ...config.hooks, enabled: true } };
      writeJson(file, config);
    } else if (tool.shape === 'flat') {
      const scriptFile = installScript(name);
      const config = readJson(file) ?? {};
      config.version = config.version ?? 1;
      config.hooks = config.hooks ?? {};
      for (const [event, timeout] of Object.entries(tool.events)) {
        const kept = (Array.isArray(config.hooks[event]) ? config.hooks[event] : []).filter((entry) => !isScriptEntry(entry));
        config.hooks[event] = [...kept, { command: scriptFile, timeout }];
      }
      writeJson(file, config);
    } else if (tool.shape === 'plugin') {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, opencodePlugin(minSeverity));
    }
    const already = report.find((item) => item.name === name)?.hooked;
    process.stdout.write(`✓ ${tool.label} hooks 已${already ? '更新' : '写入'} ${file}\n`);
    installedEvents.push(`${tool.label}：${tool.note}`);
  }

  const levelNote = minSeverity
    ? `\n通知级别：仅推送 ${minSeverity} 及以上（等你操作与失败=critical、工具失败=warning、任务完成=success、轻提示=info）。`
    : `\n通知级别：默认全部推送。想只收关键信息，重装时加 --only critical|warning|success，
或设环境变量 WALKIE_MIN_SEVERITY（脚本会读取）。`;
  // 密钥只从环境变量读，所以这一步不做就等于没装——把当前 shell 的原话给出来
  const exports = process.platform === 'win32'
    ? [`$env:WALKIE_URL = "${baseUrl}"`, '$env:WALKIE_TOKEN = "<你的 Agent Key>"', ...(destination ? [`$env:WALKIE_DESTINATION = "${destination}"`] : [])]
    : [`export WALKIE_URL="${baseUrl}"`, 'export WALKIE_TOKEN=<你的 Agent Key>', ...(destination ? [`export WALKIE_DESTINATION="${destination}"`] : [])];
  const profile = process.platform === 'win32' ? 'PowerShell 的 $PROFILE' : (String(process.env.SHELL ?? '').includes('zsh') ? '~/.zshrc' : '~/.bashrc');
  const skipped = KNOWN_TOOLS.filter((name) => !targets.includes(name));
  process.stdout.write(`
已安装 ${targets.length} 个工具的 hooks。下一步（必做）——把凭据写进 ${profile}：
${exports.map((line) => `  ${line}`).join('\n')}

触发时机：
${installedEvents.map((line) => `  · ${line}`).join('\n')}${levelNote}
${skipped.length ? `\n没装的：${skipped.map((name) => TOOLS[name].label).join('、')}（重跑并选序号，或 --tools ${skipped[0]}）` : ''}
自检：walkie-notify hook --detect    卸载：walkie-notify hook --uninstall
`);
  process.exit(0);
}

usageError(`unknown command "${command}" (send | status | hook)`);
