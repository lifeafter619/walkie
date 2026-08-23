# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- **`walkie-notify send` ignored the variable its own hook installer tells you to export.** The generated forwarding scripts and the post-install hint use `WALKIE_TOKEN`, but `send` / `status` / `hook` only read `WALKIE_API_KEY` — so following the printed instructions and then sending a notification by hand failed with `missing --token`. Both names are accepted now (`WALKIE_TOKEN` first), matching what `walkie-mcp` already did.
- `bin` paths dropped the `./` prefix, so `npm publish` no longer prints `"bin[walkie-notify]" script name walkie.mjs was invalid and removed` — npm normalises the path and keeps the entry, but the wording reads like a broken package.

## [0.4.0] — 2026-08-22

### Hook install flow — probe the machine, then ask

- `walkie-notify hook` now detects agents by config directory **and** by executable on PATH, so a tool that is installed but never launched is offered too. It prints a status list (already hooked / detected / not found) and asks which to install; pressing Enter takes the recommendation.
- `--detect` reports and exits without writing anything and without needing a token; `--yes` installs every detected agent unattended (the same path CI and other non-TTY runs take).
- `--uninstall` without `--tools` now removes hooks from every tool that actually has them, instead of only the ones currently detected.
- Re-installing reports "更新" instead of "写入", and the closing summary prints the exact `export` lines for the current shell plus which tools were skipped.

### Coding-agent hooks — schemas verified against vendor docs, three more tools

- **Fixed: Codex hooks never fired.** `~/.codex/hooks.json` was written in Cursor's flat shape; Codex uses the Claude-style nested schema (event → matcher group → handler). Now written correctly, with `Stop` and `PermissionRequest`.
- **Fixed: Cursor notifications lost the project name.** Cursor hook payloads carry `workspace_roots`, not `cwd`, and `sessionEnd` errors arrive in `error_message` — both are read now.
- Added `PermissionRequest` (Codex / Qwen Code / ZCode) as a critical "waiting for your approval" event. `Notification` now defaults to delivery for every type except `agent_completed` / `idle_prompt` / `auth_success`, instead of matching a whitelist — Gemini CLI sends `notification_type: "ToolPermission"` and Droid sends no type at all, both of which the whitelist silently dropped.
- New tools: **Qwen Code** (`~/.qwen/settings.json`), **Droid / Factory** (`~/.factory/hooks.json`, events at the top level with no wrapper) and **opencode** (a generated plugin, since it has no hook config file).
- Claude Code's `Notification` hook no longer carries a matcher, so elicitation prompts reach you too; the server still drops no-op types like `auth_success`.

### Hardening found by the pre-commit audit

- **Fixed: forwarding script built a broken URL when `--only` was set without `--destination`.** The query string always started with `&` (no `?`), so every forwarded event hit a 404 and no notification was ever delivered — silently, because the script swallows errors by design. The query is now assembled segment by segment (`${query:+?$query}`), verified against a real `sh` in six environment combinations.
- The agent-hook endpoint no longer returns 500 on malformed field types: a payload like `{"message": 42}` used to throw inside the event mapper. All string fields are now type-narrowed before use; malformed values are dropped and the event still maps by its semantics.
- `--uninstall` writes nothing unless it actually removed a handler — a no-op uninstall no longer creates an empty config file for a tool that was never hooked, nor reformats an existing one.
- Uninstall also preserves non-array values in the hooks table (unknown-schema config keys survive), and cleans up an orphaned forwarding script even when its config file is gone.

### Windows hooks — installed successfully, never fired

- **Fixed: every command-hook tool was dead on Windows.** The forwarding script was written as `walkie-notify.sh` and referenced verbatim as the hook command; `cmd.exe` cannot execute it, so Codex / Cursor / Qwen Code / Gemini CLI / Droid / ZCode installed cleanly and then never notified anything. Windows now gets `walkie-notify.ps1`, invoked as `powershell -NoProfile -ExecutionPolicy Bypass -File …` (built-in Windows PowerShell 5.1 — no curl, no Git Bash).
- **Fixed: the script path was JSON-escaped twice**, so configs contained `C:\\Users\\…` and the tools looked for a file that does not exist.
- **Fixed: PowerShell decoded the generated script with the machine's ANSI code page** (no BOM), which on a Chinese locale swallowed the line after a comment and produced an empty payload; the script is now written with a UTF-8 BOM.
- **Fixed: notification bodies arrived as mojibake on Windows.** `[Console]::In.ReadToEnd()` decodes stdin with the console code page; the payload is now passed through as raw bytes, so Chinese text and emoji survive.
- `--uninstall` now recognises both script names (`.sh` and `.ps1`), so hooks installed on another platform are cleaned up too — and it matches the script filename only, so a hand-written `walkie-notify send …` hook of your own is left alone.
- CI runs the full verify job on `windows-latest` as well — the reason all of the above was invisible.
- The CLI test suite now executes the generated PowerShell hook against a local server and asserts the exact forwarded URL, `Authorization` header and byte-identical body.

### Correctness fixes from the vendor-doc audit

- **Fixed: Qwen Code hooks were killed after 15 ms.** Its `timeout` is in milliseconds (like Gemini CLI), not seconds as in Codex / Droid / Cursor / ZCode.
- **Fixed: the opencode plugin listened on `permission.updated`**, an event that does not exist — it is `permission.asked`.
- **Fixed: the hook endpoint answered unauthenticated requests with 200 on Cloudflare.** Authentication now runs before event mapping, so `ignored` / `filtered` responses cannot leak from a missing or revoked key (the Node path was already covered by middleware; the Worker/Durable Object path was not). A bad key with `--only critical` could also pass the install probe this way.
- The install probe now says when its own test notification was filtered by `--only`, instead of implying a notification was delivered.
- ZCode installs warn that hooks are user-scope only and are snapshotted at session start, so the session has to be restarted.
- **Fixed: `npm run typecheck` was red on main** — the test project did not compile (a deliberately malformed hook payload was typed as `HookInput`).

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

### Coding-agent hooks

- `POST /api/v1/hooks/claude` receives Claude Code (v2.1+) native HTTP hook events — zero scripts. Severity mapping: permission waits and API failures → critical, task completion → success; high-frequency no-op events are acknowledged silently.
- Cursor support via a forwarding script (`scripts/cursor-hook-notify.sh`) that POSTs command-hook events to the same endpoint and never blocks the workflow.

### Rich notifications

- Notifications with a URL now render a tappable **View details** button on Telegram, Slack and Discord (alongside `ask_user` option buttons), instead of a bare link.
- Web Push severity tiers: RFC 8030 `urgency` mapping (critical/warning → high, info → low), shortened TTL for critical pushes, and `requireInteraction` + distinct vibration patterns in the service worker so critical alerts stay on screen.

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
