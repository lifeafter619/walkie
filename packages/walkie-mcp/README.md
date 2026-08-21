# walkie-mcp

stdio MCP wrapper for [Walkie](https://github.com/lifeafter619/walkie) — forwards newline-delimited JSON-RPC from stdin to a remote Walkie `/mcp` (Streamable HTTP) endpoint.

B-class agent-notification competitors are all stdio MCP with zero deployment. This wrapper gives Walkie the same "zero setup" story: `npx walkie-mcp` is the entire installation, while the actual server (channels, console, delivery audit, retry queue) keeps running wherever you deployed it.

Zero dependencies. Node ≥ 22.

## Usage | 使用

```bash
npx -y walkie-mcp --url https://walkie.example.com --token <AgentKey>
```

Environment fallbacks: `WALKIE_URL` (or `WALKIE_MCP_URL`), `WALKIE_API_KEY` (or `WALKIE_TOKEN`).

### Claude Code — `.mcp.json`

```jsonc
{
  "mcpServers": {
    "walkie": {
      "command": "npx",
      "args": ["-y", "walkie-mcp@latest", "--url", "https://walkie.example.com", "--token", "rdk_xxx"]
    }
  }
}
```

### Codex — `~/.codex/config.toml`

```toml
[mcp_servers.walkie]
command = "npx"
args = ["-y", "walkie-mcp@latest", "--url", "https://walkie.example.com", "--token", "rdk_xxx"]
```

### 中文说明

把远端 Walkie 的 Streamable HTTP MCP 端点包成本地 stdio MCP：stdin 读 JSON-RPC，POST 到远端 `/mcp`，SSE 响应逐条增量写回 stdout。`npx walkie-mcp` 即完成安装，无需本地部署；渠道配置、控制台与投递审计仍在远端实例上。

```bash
WALKIE_URL=https://walkie.example.com WALKIE_API_KEY=rdk_xxx npx walkie-mcp
```

## Behavior notes

- Responses in `text/event-stream` are forwarded incrementally (each `message` event becomes one stdout line) — tool results stream to the agent as they arrive.
- HTTP/network errors become JSON-RPC error responses (`-32603`) on stdout; the loop keeps running.
- Per-request timeout defaults to 120 s (`--timeout <sec>`).
- Exit code 0 when stdin closes.
