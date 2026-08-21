# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/).

## [0.3.0] — 2026-08-21

First public release.

### Two-way conversations (agent ↔ human)

- `ask_user` MCP tool with one-time reply links, tappable inline buttons on Telegram / Slack / Discord, and free-text replies in chat (Telegram & Slack).
- `wait_for_inbox` MCP long-poll tool: steer a running agent by messaging it unprompted from the console or a connected chat channel. Each message is claimed exactly once.
- Console conversations page with reply UI and an inbox panel.

### Notification channels

- 60+ native providers across chat (Telegram, Slack, Discord, Feishu, DingTalk, WeCom, WhatsApp, Signal, KOOK, Zulip…), email (SMTP, SES, SendGrid, Resend, Mailgun, Brevo, Postmark…), mobile push (Bark, ntfy, Gotify, PushPlus, PushDeer, JPush, Getui, Huawei/Xiaomi/OPPO/vivo/HONOR push, FCM, Expo, OneSignal…), SMS (Twilio, Aliyun, Tencent, AWS SNS, Vonage…), and universal webhooks / Apprise.
- Built-in Web Push (VAPID ES256 + RFC 8291 aes128gcm) with a console subscription panel — no third-party account, no app store.
- Per-channel rate limiting, quiet hours (with IANA timezone), and per-channel retry budgets.

### Compatibility endpoints

- Drop-in endpoints for Bark, ServerChan, Gotify, PushPlus, ntfy, Slack/Discord webhooks, Alertmanager, Pushover and Apprise — point existing tools at Walkie without changing anything.

### Reliability

- Fanout / fallback routing, exponential backoff, idempotency keys, delivery callbacks, server-side search & cursor paging.
- Data retention policies per table, audit log, platform usage monitoring with quota alerts.
- Credentials encrypted at rest (AES-256-GCM under a MASTER_KEY); scoped API keys (`notifications:send`, `deliveries:read`, `config:write`, …) with optional destination whitelists.

### MCP server

- Streamable HTTP at `/mcp`; tools: `send_notification`, `ask_user`, `check_reply`, `wait_for_inbox`, `get_delivery`, `list_destinations`, plus a `config:write` toolset that lets an agent set up channels and routes from natural language.
- One-line remote install: `npx walkie-mcp@latest --url https://your-host --token rdk_…`.

### Deploy anywhere

- One-click deploy buttons for Cloudflare Workers, Vercel (Turborepo-style API routes + Turso) and Render; plain Node/Docker for self-hosting.
- OpenAPI 3.1 spec at `/openapi.json`; zero-dependency CLI `walkie-notify` (`npx walkie-notify send …`) for CI pipelines and a ready-made GitHub Action.

### Known limitations

- Discord has no free-text reply path (interactions only) — ordinary messages require a persistent Gateway connection, which serverless runtimes cannot hold.
- Direct APNs is not implemented (needs HTTP/2 transport everywhere); use FCM/Expo/OneSignal-style bridges instead.
