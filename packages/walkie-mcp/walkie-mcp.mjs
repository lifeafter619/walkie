#!/usr/bin/env node
// walkie-mcp — stdio MCP wrapper for Walkie (#12).
//
// Reads newline-delimited JSON-RPC messages from stdin and forwards each one as
// a POST to a remote Walkie /mcp (Streamable HTTP) endpoint. Responses come
// back either as `application/json` (single body → one stdout line) or as
// `text/event-stream` (each SSE `message` event is forwarded incrementally as
// its own stdout line, so agents see tool results as they arrive).
//
// Zero dependencies, Node >= 22 (global fetch, ReadableStream iteration).

import { Readable } from 'node:stream';
import process from 'node:process';

const USAGE = `walkie-mcp — stdio MCP wrapper for Walkie

Forwards stdin JSON-RPC to a remote Walkie /mcp (Streamable HTTP) endpoint,
so any stdio-only MCP client can use a deployed Walkie server with zero
extra deployment ("npx walkie-mcp" is the whole setup).

Usage:
  walkie-mcp [--url https://host/mcp] [--token <apiKey>]
  walkie-mcp --url https://host/mcp --token <key> --timeout 60

Options:
  --url <url>        Walkie MCP endpoint, e.g. https://walkie.example.com/mcp
                     (default: $WALKIE_URL or $WALKIE_MCP_URL with /mcp appended
                     when missing, or $WALKIE_MCP_URL verbatim)
  --token <key>      Agent API key, sent as "Authorization: Bearer <key>"
                     (default: $WALKIE_API_KEY or $WALKIE_TOKEN)
  --timeout <sec>    Per-request timeout in seconds (default: 120)
  -h, --help         Show this help
  -v, --version      Show version

Environment:
  WALKIE_URL         Base URL of the Walkie server (e.g. https://host)
  WALKIE_MCP_URL     Full MCP endpoint URL (takes precedence for the URL)
  WALKIE_API_KEY     Agent API key
  WALKIE_TOKEN       Alias for WALKIE_API_KEY

Both a URL and a token are required; missing either exits with code 1.
Exit code is 0 when stdin closes.

Example (Claude Code / Codex stdio config):
  { "mcpServers": { "walkie": {
      "command": "npx",
      "args": ["-y", "walkie-mcp@latest", "--url", "https://host/mcp", "--token", "rdk_..."]
  } } }
`;

const VERSION = '0.4.0';

/** Parse CLI args of the form --flag value / --flag=value. */
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
    } else if (key === 'help' || key === 'version') {
      value = true;
    } else {
      value = argv[i + 1];
      i++;
    }
    out[key] = value;
  }
  return out;
}

/** Normalize the endpoint: accept a bare origin, or an origin + any path, and
 *  make sure it ends up pointing at the /mcp route unless the caller gave a
 *  path that already looks like the MCP endpoint. */
function normalizeUrl(raw) {
  let url = String(raw).trim().replace(/\/+$/, '');
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (parsed.pathname === '' || parsed.pathname === '/') url = `${parsed.origin}/mcp`;
    else if (!parsed.pathname.endsWith('/mcp')) url = `${parsed.origin}${parsed.pathname}/mcp`;
    return url;
  } catch {
    return url; // let fetch produce the error later
  }
}

function fail(message) {
  process.stderr.write(`walkie-mcp: ${message}\n\n${USAGE}`);
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
// -h/-v 不以 -- 开头，parseArgs 会把它们收进 _；短旗标同样要认
const flagged = (long, short) => Boolean(args[long]) || args._.includes(short);
if (flagged('help', '-h')) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (flagged('version', '-v')) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

const rawUrl = String(args.url ?? process.env.WALKIE_MCP_URL ?? process.env.WALKIE_URL ?? '').trim();
const token = String(args.token ?? process.env.WALKIE_API_KEY ?? process.env.WALKIE_TOKEN ?? '').trim();

if (!rawUrl && !token) fail('missing both --url and --token (set WALKIE_URL / WALKIE_API_KEY)');
if (!rawUrl) fail('missing --url (set WALKIE_URL or WALKIE_MCP_URL)');
if (!token) fail('missing --token (set WALKIE_API_KEY or WALKIE_TOKEN)');

const endpoint = normalizeUrl(rawUrl);
const timeoutMs = Math.max(1, Number(args.timeout ?? 120) * 1000);

// ---- output ---------------------------------------------------------------

/** Serialize a JSON-RPC message as a single stdout line. Never throws. */
function emit(value) {
  try {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  } catch {
    /* stdout closed — nothing sensible to do */
  }
}

function emitJsonRpcError(id, message) {
  emit({ jsonrpc: '2.0', id: id ?? null, error: { code: -32603, message } });
}

// ---- SSE parsing ----------------------------------------------------------

/**
 * Incrementally forward SSE `message` events from a response body to stdout.
 * Handles CR/LF/CRLF line endings and multi-line `data:` fields. Resolves when
 * the stream ends; rejects on stream errors (caller converts those into
 * JSON-RPC errors).
 */
async function pumpEventStream(body, isDone) {
  const decoder = new TextDecoder();
  let buffer = '';
  let eventName = '';
  let dataLines = [];

  const flush = () => {
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n');
    dataLines = [];
    const name = eventName;
    eventName = '';
    if (name === 'done' || data === '') return; // stream terminator used by some servers
    if (name && name !== 'message') return; // ping/endpoint/other events: ignore
    const text = data.trim();
    if (!text) return;
    try {
      emit(JSON.parse(text)); // normalize formatting into one compact line
    } catch {
      process.stdout.write(`${data}\n`); // not JSON — forward verbatim
    }
  };

  const feed = (chunk) => {
    buffer += chunk;
    let index;
    // eslint-disable-next-line no-cond-assign
    while ((index = buffer.search(/\r\n|\r|\n/)) !== -1) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + (buffer.slice(index).startsWith('\r\n') ? 2 : 1));
      if (line === '') {
        flush(); // blank line terminates an event
        if (isDone()) return;
        continue;
      }
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') eventName = value;
      else if (field === 'data') dataLines.push(value);
    }
  };

  for await (const chunk of body) {
    feed(decoder.decode(chunk, { stream: true }));
    if (isDone()) break;
  }
  feed(decoder.decode());
  flush();
}

// ---- request forwarding ---------------------------------------------------

/** Extract the `id` of a JSON-RPC message (requests have one, notifications don't). */
function requestId(message) {
  if (message && typeof message === 'object' && ('id' in message)) {
    const id = message.id;
    return typeof id === 'string' || typeof id === 'number' ? id : null;
  }
  return null;
}

/** JSON-RPC forbids a response to a notification; only requests (id present) get an error back. */
function reportFailure(id, reason) {
  if (id !== null) emitJsonRpcError(id, reason);
}

async function forward(message) {
  const id = requestId(message);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify(message),
      signal: controller.signal
    });

    const contentType = String(response.headers.get('content-type') ?? '').toLowerCase();

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const detail = text ? `: ${text.slice(0, 500)}` : '';
      reportFailure(id, `HTTP ${response.status} ${response.statusText}${detail}`);
      return;
    }

    if (contentType.includes('text/event-stream')) {
      if (!response.body) return;
      // Stop pumping as soon as the request is aborted (timeout).
      await pumpEventStream(response.body, () => controller.signal.aborted);
      return;
    }

    // Plain JSON (or anything else): forward the body as a single line.
    const text = await response.text();
    const trimmed = text.trim();
    if (!trimmed) return;
    if (contentType.includes('application/json')) {
      try {
        emit(JSON.parse(trimmed));
      } catch {
        process.stdout.write(`${trimmed}\n`);
      }
    } else {
      process.stdout.write(`${trimmed}\n`);
    }
  } catch (error) {
    const reason = error && error.name === 'AbortError'
      ? `request timed out after ${Math.round(timeoutMs / 1000)}s`
      : (error instanceof Error ? error.message : String(error));
    reportFailure(id, reason);
  } finally {
    clearTimeout(timer);
  }
}

// ---- stdin loop -----------------------------------------------------------

// Serialize requests: each request is fully forwarded (stream drained) before
// the next starts, which matches how stdio MCP clients consume responses and
// keeps output lines from interleaving mid-line.
let chain = Promise.resolve();
let pending = 0;
let stdinClosed = false;

function drain() {
  if (pending === 0 && stdinClosed) {
    process.exit(0);
  }
}

const rl = Readable.toWeb(process.stdin);
/** Queue one parsed JSON-RPC message for forwarding, preserving stdin order. */
function enqueue(text) {
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    emitJsonRpcError(null, `parse error: invalid JSON on stdin: ${text.slice(0, 200)}`);
    return;
  }
  pending++;
  chain = chain.then(() => forward(message)).finally(() => {
    pending--;
    drain();
  });
}

try {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of rl) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    // eslint-disable-next-line no-cond-assign
    while ((index = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, '');
      buffer = buffer.slice(index + 1);
      enqueue(line.trim());
    }
  }
  // A final message written without a trailing newline is still a message — don't drop it.
  enqueue((buffer + decoder.decode()).replace(/\r$/, '').trim());
} catch {
  /* stdin error — fall through to exit */
}
stdinClosed = true;
drain();

// Some clients keep stdin open without sending anything; still exit cleanly on end.
process.stdin.on('close', () => {
  stdinClosed = true;
  drain();
});
