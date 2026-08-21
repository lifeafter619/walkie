# walkie — CLI

Send and check [Walkie](https://github.com/lifeafter619/walkie) notifications from CI (GitHub Actions) or the terminal.

Zero dependencies. Node ≥ 22.

## Usage | 使用

```bash
npx walkie send --url https://walkie.example.com --token rdk_xxx \
  --to prod-alerts --title "Deploy failed" --body "v2.4.0 rollback executed" --severity critical
```

```bash
WALKIE_URL=https://walkie.example.com WALKIE_API_KEY=rdk_xxx \
  npx walkie send --to prod-alerts --title "Build ok" --body "sha abc1234" --severity success
```

| Command | Purpose |
| --- | --- |
| `walkie send` | POST `/api/v1/notify`; prints the delivery ID (`--json` for full response) |
| `walkie status <id>` | GET `/api/v1/deliveries/<id>`; prints JSON |

`--url`/`--token` fall back to `WALKIE_URL`/`WALKIE_API_KEY`. Exit codes: 0 ok, 1 usage error, 2 API error.

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

CI 里最常用的入口：`npx walkie send ...` 直接发通知，或在 workflow 里 `uses: lifeafter619/walkie/.github/workflows/notify.yml@main`。凭据走 `WALKIE_URL` / `WALKIE_API_KEY` secrets。`--idempotency-key` 可用于重试去重（同一 key 返回首次投递）。
