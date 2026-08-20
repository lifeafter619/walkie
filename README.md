<div align="center">

# 📻 Walkie

**A two-way walkie-talkie between AI agents and you**

Your agent calls you when work is done, asks when it is unsure, and you reply from any device — all over one MCP connection.

[![License](https://img.shields.io/badge/license-MIT-22c55e)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.3.0-black)](package.json)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-6366f1)](https://modelcontextprotocol.io)

[English](README.md) · [简体中文](README.zh-CN.md)

**One-click deploy**

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lifeafter619/walkie)
[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Flifeafter619%2Fwalkie&env=TURSO_DATABASE_URL,TURSO_AUTH_TOKEN,ADMIN_TOKEN,MASTER_KEY,CRON_SECRET&envDescription=Turso%20database%2C%20admin%20password%20and%2032-byte%20root%20key&envLink=https%3A%2F%2Fgithub.com%2Flifeafter619%2Fwalkie%23readme&project-name=walkie&repository-name=walkie)
[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/lifeafter619/walkie)

</div>

---

When an AI agent runs long tasks, you should not have to babysit the terminal. Walkie is a self-hosted notification control plane:

- **Agent → you**: build finished, deploy failed, approval needed — delivered to Telegram, WhatsApp, WeCom, Feishu, email, SMS, and 75+ more channels;
- **You → agent**: the agent calls `ask_user`, the question lands on your phone, you tap a one-time link (or reply in the console), and the agent picks up the answer and keeps working;
- **One instance, many entrances**: MCP, REST, and drop-in compatible endpoints for ServerChan, Bark, Gotify, PushPlus, ntfy, Slack, Discord, Alertmanager, Pushover, and Apprise — all sharing the same channels and Agent Keys.

## Highlights

- 📡 **75+ notification channels** — chat (Telegram / WhatsApp / WeCom app / Feishu / DingTalk / Slack / Discord / Teams / Google Chat / KOOK / official QQ bot / Matrix / LINE…), push (FCM / Expo / OneSignal / Huawei / HONOR / Xiaomi / OPPO / vivo / Meizu / JPush / Getui / Join / Pushy / Pushsafer / Simplepush / Pusher Beams / Pushpad / Bark / ntfy / Gotify / Pushover / ServerChan / PushPlus / WxPusher…), orchestration (Novu / Knock / Courier), automation (IFTTT webhooks), email (SMTP / SendGrid / Resend / Postmark / Mailgun / Brevo), SMS (Twilio / Aliyun / Tencent Cloud / AWS SNS / Vonage / Plivo / Telnyx / Bird / Infobip), PagerDuty, Jira Service Management, Alertmanager, Apprise, and generic webhooks. See [`docs/providers.md`](docs/providers.md) for each provider's contract.
- 🔁 **Two-way conversations** — `ask_user` + one-time reply link + reply from the console's session page; `check_reply` long-polls for the answer
- 🧭 **Routing** — fanout or fallback chains of channels behind one stable identifier
- 🪄 **Drop-in compatibility endpoints** — point existing ServerChan / Bark / Gotify / ntfy / PushPlus / Slack webhook / Discord webhook / Alertmanager / Pushover / Apprise tooling at Walkie with zero code changes
- 🔑 **Keys are passwords** — Agent Keys and admin passwords can both be custom strings; multiple admin passwords can coexist, with per-key stats and revocation
- 🪝 **Delivery callbacks** — `callbackUrl` receives a webhook when a delivery reaches a final state
- ⏱️ **Rate limiting & quiet hours** — per-channel rate limits; `22:00-08:00@Asia/Shanghai` defers sends while critical breaks through
- 🔒 **Secure defaults** — AES-256-GCM credential encryption (KEK/DEK two-level keys, online rotation), hashed key storage, SSRF protection (private networks and plain HTTP blocked by default), scopes and destination allowlists
- 📱 **Console** — responsive admin panel with dark mode, usable on mobile

## Getting started

Five deployment options — pick one. After it is up, open the site, sign in with the admin password, add a channel → create an Agent Key → copy the MCP config from the Integrations page.

| Platform | One-click deploy | State storage | Notes |
| --- | --- | --- | --- |
| Cloudflare Workers | [![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/lifeafter619/walkie) | Durable Objects SQLite | Generous free tier, no external database. Two secrets to add after deploy |
| Vercel | [![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Flifeafter619%2Fwalkie&env=TURSO_DATABASE_URL,TURSO_AUTH_TOKEN,ADMIN_TOKEN,MASTER_KEY,CRON_SECRET&envDescription=Turso%20database%2C%20admin%20password%20and%2032-byte%20root%20key&envLink=https%3A%2F%2Fgithub.com%2Flifeafter619%2Fwalkie%23readme&project-name=walkie&repository-name=walkie) | Turso / libSQL | Environment variables filled in the deploy form; create the Turso database first |
| Render | [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/lifeafter619/walkie) | Persistent disk SQLite | Uses `render.yaml` + Dockerfile; persistent disks need the starter plan or above |
| Docker / NAS / bare metal | See commands below | Local SQLite | Fully self-controlled, can reach intranet services |

> Instances created by one-click deploy show a setup instructions page (not a 500 error) until the required secrets are in place.

### 1. Cloudflare Workers (recommended)

State lives in Durable Objects SQLite — no external database. See [Free tiers & usage monitoring](#free-tiers--usage-monitoring) below.

Click the deploy button above; Cloudflare forks the repo into your account and creates the Durable Object automatically. **One-click deploy cannot pre-fill secrets** — the site shows a setup page first. Complete it locally:

```bash
git clone https://github.com/<your-account>/walkie.git && cd walkie
npm ci && npx wrangler login

# Generate the 32-byte root key (on Windows without openssl:
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
openssl rand -base64 32 | npx wrangler secret put MASTER_KEY

# Admin password (≥8 chars, used to sign in to the console; changeable later)
npx wrangler secret put ADMIN_TOKEN
```

To deploy fully manually instead: clone this repo, run the two secret commands above, then `npm run deploy:cf`. The site is `https://walkie.<your-subdomain>.workers.dev`.

### 2. Vercel + Turso

Serverless deployment with state in [Turso](https://turso.tech) (libSQL). Deliveries run in-request, with Vercel Cron as the retry backstop.

Create a Turso database to get `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`, then click the Vercel button — the form asks for these variables:

| Variable | Description |
| --- | --- |
| `TURSO_DATABASE_URL` | `libsql://…` database URL |
| `TURSO_AUTH_TOKEN` | Turso access token |
| `ADMIN_TOKEN` | Admin password (≥8 chars) |
| `MASTER_KEY` | base64-encoded 32-byte root key |
| `CRON_SECRET` | Random string protecting `/api/cron/drain` (injected by Vercel Cron) |
| `PUBLIC_URL` | Optional. Final site URL, e.g. `https://walkie.example.com` (used in reply links) |

Hobby plans can run cron at most once a day, so it drains the retry queue daily at 03:00 UTC; normal requests still trigger deliveries immediately.

### 3. Render

`render.yaml` carries the Docker build, health check, and a 1 GB persistent disk. After clicking the button, fill in `ADMIN_TOKEN` and `MASTER_KEY`. Note that Render free instances have no persistent disk — the blueprint defaults to the starter plan; switching back to free loses channels and keys on every redeploy.

### 4. Docker / Docker Compose

Single container with a local SQLite volume — good for NAS and home servers.

```bash
ADMIN_TOKEN='your-admin-password' \
MASTER_KEY="$(openssl rand -base64 32)" \
docker compose up -d --build
```

- Binds `127.0.0.1:4310` by default; put Nginx/Caddy in front for TLS before exposing it;
- Data lives in the `relaydock-data` volume (new installs use `/app/data/walkie.db`; older installs keep using `relaydock.db`). **Back it up together with `MASTER_KEY`** — neither can be recovered without the other.

A Caddy reverse proxy is two lines:

```
walkie.example.com {
    reverse_proxy 127.0.0.1:4310
}
```

### 5. Enterprise / private network

Bare-metal Node.js, for reaching intranet services (self-hosted Gotify, OneBot QQ bots, internal webhooks).

```bash
# Node.js ≥ 22
git clone https://github.com/lifeafter619/walkie.git && cd walkie
npm ci && npm run build

NODE_ENV=production \
HOST=0.0.0.0 PORT=4310 \
ADMIN_TOKEN='your-admin-password' \
MASTER_KEY="$(openssl rand -base64 32)" \
ALLOW_PRIVATE_WEBHOOKS=true \
node dist/server/index.js
```

Example systemd unit:

```ini
[Unit]
Description=Walkie notification control plane
After=network-online.target

[Service]
User=walkie
WorkingDirectory=/opt/walkie
EnvironmentFile=/opt/walkie/.env
ExecStart=/usr/bin/node dist/server/index.js
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Intranet notes:

- `ALLOW_PRIVATE_WEBHOOKS=true` allows notifications to private addresses (required for OneBot, internal Apprise, etc.);
- Add `ALLOW_INSECURE_HTTP=true` when the target service is HTTP-only;
- Always put TLS in front before exposing the port, and keep `ADMIN_TOKEN` set — the process refuses to start when bound to a non-loopback address without an admin password.

### Free tiers & usage monitoring

As of 2026-08 (verify against official pages before deploying):

| Platform | Main free-plan limits | Official source |
| --- | --- | --- |
| Cloudflare Workers | 100,000 requests/day, 10 ms CPU/request, 128 MB memory; Durable Objects 100,000 requests/day; DO SQLite 5M row reads/day, 100K row writes/day, 5 GB | [Workers Limits](https://developers.cloudflare.com/workers/platform/limits/) / [Durable Objects Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) |
| Vercel Hobby (Fluid Compute) | 1,000,000 function invocations/month, 4 CPU hours/month, 360 GB-hours memory/month; cron at most once a day, ±59 min precision | [Hobby Plan](https://vercel.com/docs/plans/hobby) / [Limits](https://vercel.com/docs/limits) / [Cron](https://vercel.com/docs/cron-jobs/usage-and-pricing) |

System → Quotas & usage shows both Walkie's own delivery stats and live platform API snapshots. Platform tokens are AES-GCM encrypted with the existing DEK — the API and browser only ever see "configured", never the plaintext.

- Cloudflare: provide an API Token, Account ID, and Worker script name. Usage reads need `Account → Account Analytics → Read`; auto-detecting Workers Free/Paid additionally needs `Account → Billing → Read` (or pick the plan manually). Walkie polls the [GraphQL Analytics API](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/) every 15 minutes for the day's requests, errors, and subrequests.
- Vercel: provide an Access Token; Team ID and Project ID optional. Walkie reads the current month's FOCUS JSONL from the [Billing Charges API](https://vercel.com/docs/rest-api/billing/list-focus-billing-charges) and shows the returned services and units. Sync at most every 15 minutes while the admin page is open; idle Hobby deployments are limited by cron to roughly daily checks.
- Every metric supports an absolute threshold with actions: alert only, pause new pushes only, or both. Threshold alerts are deduplicated per billing cycle; failed API requests or stale snapshots never trigger a pause, and a pause can be lifted on the same page.

Platform billing data may lag; CPU, Durable Object row I/O, and Turso usage should still be verified in each platform's dashboard.

## Connecting your agent

Create an Agent Key on the console's Keys page (use a memorable custom string or a random `rdk_` key), then pick any entry point:

### MCP (recommended)

`https://your-domain/mcp`, Streamable HTTP + Bearer auth. The Integrations page can copy these configs:

```jsonc
// Claude Code — .mcp.json
{
  "mcpServers": {
    "walkie": {
      "type": "http",
      "url": "https://your-domain/mcp",
      "headers": { "Authorization": "Bearer ${WALKIE_API_KEY}" }
    }
  }
}
```

```toml
# Codex — ~/.codex/config.toml
[mcp_servers.walkie]
url = "https://your-domain/mcp"
bearer_token_env_var = "WALKIE_API_KEY"
```

| MCP tool | Purpose |
| --- | --- |
| `list_destinations` | List channels and routes this key may use |
| `send_notification` | Send a notification, returns a deliveryId |
| `get_delivery` | Query a delivery's overall and per-channel status |
| `ask_user` | Ask the human a question, pushes a one-time reply link |
| `check_reply` | Long-poll for the human's reply |
| `list_routes` | List usable routes |
| `list_channel_types` / `list_channels` | Channel type field definitions / channel list (`config:write`) |
| `create_channel` / `update_channel` / `delete_channel` | Channel management (`config:write`) |
| `test_channel` | Send a test message to verify connectivity (`config:write`) |
| `create_route` / `update_route` / `delete_route` | Route management (`config:write`) |

With the `config:write` scope enabled, you can just tell the agent what you want:

> "Set up a Telegram channel, Bot Token 123:abc, Chat ID 42 — and test it."

The agent calls `list_channel_types` for the fields → `create_channel` → `test_channel` → reports back. Every change is written to the audit log (admin and agent actions distinguished); config tools have no key-management powers, so an agent cannot escalate its own privileges.

### REST API

```bash
curl -X POST https://your-domain/api/v1/notify \
  -H "Authorization: Bearer <AgentKey>" \
  -H "content-type: application/json" \
  -d '{"destination":"prod-alerts","title":"Deploy done","body":"v2.4.0 is live","severity":"success"}'
```

`POST /api/v1/ask` asks a question, `GET /api/v1/conversations/:id` fetches the reply, `GET /api/v1/deliveries/:id` checks a delivery.

### Connect other Walkie instances

Walkie instances on different platforms can call each other directly: on the remote instance, create an Agent Key restricted to specific channels/routes with `notifications:send`; locally, add a "Walkie instance" channel with the remote site URL, that key, and the remote destination ID/slug. The channel then behaves like any other channel in local routes.

Cross-instance deliveries carry the local delivery ID as the remote idempotency key and record visited instances in `X-Walkie-Trace`. Re-entering the same instance or exceeding 8 hops terminates forwarding, preventing notification loops from misconfigured routes.

### Drop-in compatibility endpoints

Point existing tooling at Walkie with zero code changes — the last path segment (or the token parameter) is your Agent Key:

| Protocol | Endpoint | Auth |
| --- | --- | --- |
| ServerChan | `GET/POST /send/<AgentKey>.send` | Agent Key in the URL |
| Bark | `GET/POST /push` | Bark Device Key or Agent Key in `device_key` |
| Gotify | `POST /message` | `X-Gotify-Key` header, `?token=`, or `Authorization: Bearer` — the value is the Agent Key |
| PushPlus | `GET/POST /send` | `token` parameter is the Agent Key |
| ntfy | `POST /ntfy/<destination>` | `Authorization: Bearer <AgentKey>` |
| Slack Incoming Webhook | `POST /services/<T>/<B>/<AgentKey>` | last URL segment is the Agent Key; replies plain-text `ok` |
| Discord Webhook | `POST /api/webhooks/<id>/<AgentKey>` | last URL segment is the Agent Key; supports `?wait=true` |
| Alertmanager / Grafana | `POST /alertmanager?key=<AgentKey>` | `?key=` or Bearer; `alerts[]` become notifications, deduplicated by fingerprint |
| Pushover | `POST /1/messages.json` | `token` or `user` field is the Agent Key; priority on the -2..2 scale |
| Apprise API | `POST /notify/<AgentKey>` | Agent Key in the URL or Bearer; `type` maps to severity |

The Slack endpoint means any tool with a "Slack webhook URL" field — GitHub, GitLab, Grafana, Sentry, Prometheus, Jenkins, Uptime Kuma, Datadog — can be pointed at Walkie as-is. Full parameter lists per protocol are on the console (System → Instance status → compatibility endpoints).

Gotify and PushPlus deliver directly when the Agent Key has exactly one destination; ntfy addresses a channel or route by the `destination` path segment.

## How two-way confirmation works

```
Agent  ── ask_user("roll back?", options) ──► Walkie
Walkie ── pushes question + one-time link ──► your phone (any configured channel)
You    ── tap an option or type a reply ──► Walkie
Agent  ── check_reply long-poll ──► gets the answer, keeps going
```

Links are one-time and expire (30 seconds to 24 hours, configurable). The recipient needs no account.

## Environment variables

| Variable | Default | Description |
| --- | --- | --- |
| `ADMIN_TOKEN` | — | Admin password (≥8 chars). Required in production; can coexist with console-managed passwords |
| `MASTER_KEY` | — | base64 32-byte root key (KEK) encrypting all channel credentials. Required in production; **data is unrecoverable if lost** |
| `PORT` / `HOST` | `4310` / `127.0.0.1` | Listen address (Node deploy) |
| `DATA_DIR` | `./data` | SQLite data directory (Node deploy) |
| `ALLOW_PRIVATE_WEBHOOKS` | `false` | Allow notifications to private/loopback addresses |
| `ALLOW_INSECURE_HTTP` | `false` | Allow plain-HTTP notification targets |
| `DELIVERY_WORKERS` | `2` | Concurrent deliveries per drain cycle |
| `MAX_SENDS_PER_MIN` | `0` | Global per-minute send cap, 0 = unlimited |
| `MAX_DELIVERY_ATTEMPTS` | `4` | Max attempts per channel (exponential backoff); per-channel overrides available |
| `RETRY_BASE_MS` | `2000` | Retry backoff base |
| `PUBLIC_URL` | — | Public site URL (reply links, MCP config display) |
| `UPDATE_REPO` | `lifeafter619/walkie` | GitHub repo for in-app update checks (owner/name; change for forks) |
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | — | Turso/libSQL remote database (Vercel deploy) |
| `CRON_SECRET` | — | Vercel cron authentication |

## Security model

- Channel credentials are AES-256-GCM encrypted at rest; two-level keys (env `MASTER_KEY` as KEK, data key DEK rotatable online from the console with atomic re-encryption);
- Agent Keys and admin passwords are stored as sha256 hashes for auth; Agent Keys keep an encrypted copy for console viewing;
- Outbound notifications reject private/loopback/reserved addresses and plain HTTP by default (SSRF protection); redirects are always rejected;
- Every Agent Key can be scoped (send / read / config) with a destination allowlist (e.g. five keys for five channels), editable anytime, revocable in one click;
- Reply links carry a one-time token invalidated on first reply; all sensitive operations land in the audit log, searchable by actor and action in the console;
- The System page configures data retention and delivery soft limits; usage refreshes every 30 seconds and expired data is purged automatically or manually.

## FAQ

**Forgot the admin password?** Set a new env password: `wrangler secret put ADMIN_TOKEN` on Cloudflare, or change the environment variable and restart on Docker/Node. After signing in, you can create additional admin passwords on the Keys page and revoke them one by one; the env password can only be changed on the deploy platform. The system blocks revoking the last valid credential.

**Lost an Agent Key after switching devices?** The Keys page shows and copies it (stored encrypted in plaintext-readable form); or revoke and recreate.

**Startup says "MASTER_KEY does not match this database"?** The current `MASTER_KEY` is not the one this data was created with (rotated key, restored backup without the key, or multiple environments sharing one data directory). Restore the original key — Walkie refuses to write with a wrong key. If the key is truly lost, channel credentials cannot be recovered; the only option is wiping the data directory/database and starting over.

**Does SMTP work on Cloudflare?** Workers' `nodejs_compat` provides TCP sockets, so most 465/587 SMTP services work; otherwise prefer HTTP-based channels or send mail from the Node/Docker deploy.

**Notification missing?** The Deliveries page shows every channel's attempts and errors; the Channels page has a one-click test.

## Development

```bash
npm ci
npm run dev        # API (Node, port 4310)
npm run dev:web    # Console (Vite)
npm test           # vitest
npm run typecheck
```

Architecture: `src/server` (Express + queue + channel dispatch, shared by Node/Vercel/Workers), `src/worker` (Cloudflare Durable Object entry), `src/web` (React console), `api/` (Vercel entry). See [CONTRIBUTING.md](CONTRIBUTING.md) to add channels, and [docs/roadmap.md](docs/roadmap.md) for planned extensions.

## License

[MIT](LICENSE)
