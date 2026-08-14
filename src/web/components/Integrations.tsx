import { useState } from 'react';
import { Bot, Code2, Copy, KeyRound, Network, SquareTerminal } from 'lucide-react';
import { Button, IconButton, Notify } from './ui';

type Meta = {
  version: string;
  runtime: 'node' | 'cloudflare-workers';
  publicUrl: string;
  mcpUrl: string;
};
type Client = 'codex' | 'claude' | 'cursor' | 'generic';

/* ────────────────────────────────────────────────────────────
 * MCP 接入：端点 + 客户端配置片段。
 * ──────────────────────────────────────────────────────────── */

export function Integrations({ meta, notify }: { meta: Meta; notify: Notify }) {
  const [client, setClient] = useState<Client>('codex');

  const snippets = {
    codex: {
      label: 'Codex', path: '~/.codex/config.toml', icon: SquareTerminal,
      content: `[mcp_servers.relaydock]\nurl = "${meta.mcpUrl}"\nbearer_token_env_var = "RELAYDOCK_API_KEY"\ndefault_tools_approval_mode = "writes"`
    },
    claude: {
      label: 'Claude Code', path: '.mcp.json', icon: Bot,
      content: JSON.stringify({ mcpServers: { relaydock: { type: 'http', url: meta.mcpUrl, headers: { Authorization: 'Bearer ${RELAYDOCK_API_KEY}' } } } }, null, 2)
    },
    cursor: {
      label: 'Cursor', path: '.cursor/mcp.json', icon: Code2,
      content: JSON.stringify({ mcpServers: { relaydock: { url: meta.mcpUrl, headers: { Authorization: 'Bearer ${env:RELAYDOCK_API_KEY}' } } } }, null, 2)
    },
    generic: {
      label: '通用 MCP', path: 'Streamable HTTP', icon: Network,
      content: JSON.stringify({ transport: 'streamable-http', url: meta.mcpUrl, headers: { Authorization: 'Bearer <Agent API Key>' } }, null, 2)
    }
  } as const;

  const selected = snippets[client];
  const copy = async (value: string, message: string) => {
    await navigator.clipboard.writeText(value);
    notify('success', message);
  };

  return (
    <>
      <header className="page-head"><h1>接入</h1></header>

      <div className="integration-layout">
        <section className="panel endpoint-panel">
          <div className="section-head">
            <h2>MCP 端点</h2>
            <IconButton label="复制 MCP URL" icon={Copy} onClick={() => copy(meta.mcpUrl, 'MCP URL 已复制')} />
          </div>
          <div className="endpoint-url"><code>{meta.mcpUrl}</code></div>
          <p className="panel-note">使用 Bearer Agent API Key 鉴权，密钥在「密钥」页创建。</p>
        </section>

        <section className="panel integration-config">
          <div className="client-tabs" role="tablist">
            {Object.entries(snippets).map(([id, item]) => {
              const Icon = item.icon;
              return (
                <button key={id} role="tab" aria-selected={client === id} className={client === id ? 'active' : ''} onClick={() => setClient(id as Client)}>
                  <Icon size={15} /><span>{item.label}</span>
                </button>
              );
            })}
          </div>
          <div className="config-head">
            <div><strong>{selected.label}</strong><code>{selected.path}</code></div>
            <Button icon={Copy} onClick={() => copy(selected.content, `${selected.label} 配置已复制`)}>复制配置</Button>
          </div>
          <pre className="integration-code">{selected.content}</pre>
        </section>

        <aside className="integration-notes">
          <section className="panel">
            <div className="section-head"><h2>连接检查</h2></div>
            <dl className="connection-facts">
              <div><dt>传输</dt><dd>Streamable HTTP</dd></div>
              <div><dt>鉴权</dt><dd>Authorization: Bearer</dd></div>
              <div><dt>会话</dt><dd>Stateless</dd></div>
              <div><dt>端点</dt><dd><code>/mcp</code></dd></div>
            </dl>
          </section>
          <section className="panel env-callout">
            <KeyRound size={17} />
            <div><strong>RELAYDOCK_API_KEY</strong><p>在「密钥」页创建，原始值只显示一次。</p></div>
          </section>
        </aside>
      </div>
    </>
  );
}
