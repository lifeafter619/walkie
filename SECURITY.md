# Security Policy

Please report vulnerabilities privately to the repository owner rather than opening a public issue. Include affected versions, reproduction steps, impact, and any suggested mitigation.

## Deployment expectations

- Set unique, high-entropy `ADMIN_TOKEN` and `MASTER_KEY` values before exposing the service.
- Terminate TLS at a trusted reverse proxy and restrict direct access to port 4310.
- Keep `ALLOW_PRIVATE_WEBHOOKS=false` unless the instance is intentionally sending to internal services.
- Back up the SQLite database together with the exact `MASTER_KEY`; neither is useful alone for recovery.
- Give each Agent its own restricted API Key and revoke unused keys.
- Apply host-level egress controls when untrusted administrators can configure generic webhook targets.

Supported security fixes are made on the latest release line.
