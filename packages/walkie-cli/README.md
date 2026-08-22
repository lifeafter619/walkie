# walkie-notify — CLI

Send and check [Walkie](https://github.com/lifeafter619/walkie) notifications from CI (GitHub Actions) or the terminal.

Zero dependencies. Node ≥ 22.

## Usage | 使用

```bash
npx walkie-notify send --url https://walkie.example.com --token rdk_xxx \
  --to prod-alerts --title "Deploy failed" --body "v2.4.0 rollback executed" --severity critical
```

```bash
WALKIE_URL=https://walkie.example.com WALKIE_API_KEY=rdk_xxx \
  npx walkie-notify send --to prod-alerts --title "Build ok" --body "sha abc1234" --severity success
```

| Command | Purpose |
| --- | --- |
| `walkie-notify send` | POST `/api/v1/notify`; prints the delivery ID (`--json` for full response) |
| `walkie-notify status <id>` | GET `/api/v1/deliveries/<id>`; prints JSON |
| `walkie-notify hook` | Install coding-agent hooks (`--uninstall` removes them) |

`--url`/`--token` fall back to `WALKIE_URL`/`WALKIE_API_KEY`. Exit codes: 0 ok, 1 usage error, 2 API error.

## Coding-agent hooks | 编码 Agent hooks

```bash
npx walkie-notify hook --url https://walkie.example.com --token rdk_xxx --only critical
```

Probes the machine (each tool's config directory **and** its executable on PATH, so an
agent installed but never launched is still found), prints what it found, and asks which
to set up. **Claude Code, Cursor, Codex, Qwen Code, Gemini CLI, Droid (Factory), ZCode
and opencode** are supported; desktop apps share the same config files as their CLIs.

| Flag | Effect |
| --- | --- |
| `--detect` | Report detected agents and exit — writes nothing, needs no token |
| `--yes` | Install every detected agent without asking (also the non-TTY/CI behaviour) |
| `--tools claude,cursor,…` | Force an exact set instead of the detected one |
| `--scope project` | Write into the current repo instead of `$HOME` |
| `--uninstall` | Remove walkie hooks (without `--tools`: from every tool that has them) |

A real test notification is sent before anything is written; existing hooks are preserved
and re-running is idempotent.

The token is never written to a config file — export `WALKIE_URL` and `WALKIE_TOKEN`
in your shell profile (on Windows: `$env:WALKIE_URL` / `$env:WALKIE_TOKEN` in `$PROFILE`,
where the forwarding script is generated as PowerShell). `--only <critical|warning|success|info>`
sets the minimum severity; `WALKIE_MIN_SEVERITY` changes it later without reinstalling.

## GitHub Actions

The repo ships a reusable workflow at `.github/workflows/notify.yml`:

```yaml
jobs:
  notify:
    uses: lifeafter619/walkie/.github/workflows/notify.yml@main
    secrets:
      WALKIE_URL: https://walkie.example.com
      WALKIE_API_KEY: ${{ secrets.WALKIE_API_KEY }}
    with:
      destination: prod-alerts
      title: "Deploy finished"
      body: "v2.4.0 deployed by ${{ github.actor }}"
      severity: success
      link: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
```

### 中文说明

CI 里最常用的入口：`npx walkie-notify send ...` 直接发通知，或在 workflow 里 `uses: lifeafter619/walkie/.github/workflows/notify.yml@main`。凭据走 `WALKIE_URL` / `WALKIE_API_KEY` secrets。`--idempotency-key` 可用于重试去重（同一 key 返回首次投递）。
