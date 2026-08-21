#!/usr/bin/env node
// walkie — CLI for Walkie (#15): send notifications from CI (GitHub Actions) or the terminal.
//
//   walkie send --url https://host --token <key> --to prod-alerts --title "..." --body "..."
//   walkie status <deliveryId> --url https://host --token <key>
//
// Zero dependencies, Node >= 22 (global fetch).

import process from 'node:process';

const VERSION = '0.1.0';

const USAGE = `walkie — CLI for Walkie notifications

Usage:
  walkie send [options]              Send a notification via POST /api/v1/notify
  walkie status <deliveryId> [options]   Fetch delivery status via GET /api/v1/deliveries/<id>
  walkie --help | --version

Options for send:
  --url <url>          Walkie base URL, e.g. https://walkie.example.com
                       (default: $WALKIE_URL)
  --token <key>        Agent API key, sent as Bearer (default: $WALKIE_API_KEY)
  --to <destination>   Destination ID or slug (channel / route)
  --title <text>       Notification title (required)
  --body <text>        Notification body (required)
  --severity <level>   info | success | warning | critical (default: info)
  --tags <tags>        Pipe-separated tags, e.g. "ops|deploy"
  --url <link>         Notification link URL (attach after --title/--body via --link)
  --link <url>         Notification link URL (clearer alias for the link field)
  --idempotency-key <k>  Dedup key: retries with the same key return the original delivery
  --json               Print the full JSON response instead of just the delivery ID

Options for status:
  --url / --token / --json   Same as send

Exit codes: 0 success, 1 usage error, 2 API error (response body printed to stderr).

Example:
  walkie send --url https://walkie.example.com --token rdk_xxx \\
    --to prod-alerts --title "Deploy failed" --body "v2.4.0 rollback executed" --severity critical
`;

const BOOLEAN_FLAGS = new Set(['help', 'h', 'version', 'v', 'json']);

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
  process.stderr.write(`walkie: ${message}\n\n${USAGE}`);
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
    process.stderr.write(`walkie: request failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    process.stderr.write(`walkie: HTTP ${response.status}: ${text.slice(0, 2000)}\n`);
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
    ...(args.idempotencyKey ? { idempotencyKey: String(args.idempotencyKey) } : {})
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

usageError(`unknown command "${command}" (send | status)`);
