import { useState } from 'react';
import { Bot, Code2, Copy, KeyRound, Network, ShieldCheck, SquareTerminal } from 'lucide-react';
import { Button, IconButton, Notify } from './ui';

type Meta = {
  version: string;
  runtime: 'node' | 'cloudflare-workers';
  publicUrl: string;
  mcpUrl: string;
};
type Client = 'codex' | 'claude' | 'cursor' | 'generic';

/* ────────────────────────────────────────────────────────────
 * MCP 接入：客户端配置片段与远程端点。
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
    <div className="integration-layout">
      <section className="panel endpoint-hero">
        <div>
          <span className="eyebrow">STREAMABLE HTTP</span>
          <h2>{meta.mcpUrl}</h2>
          <p>Bearer Agent API Key</p>
        </div>
        <IconButton label="复制 MCP URL" icon={Copy} onClick={() => copy(meta.mcpUrl, 'MCP URL 已复制')} />
      </section>

      <section className="panel integration-config">
        <div className="client-tabs" role="tablist">
          {Object.entries(snippets).map(([id, item]) => {
            const Icon = item.icon;
            return (
              <button key={id} role="tab" aria-selected={client === id} className={client === id ? 'active' : ''} onClick={() => setClient(id as Client)}>
                <Icon size={16} /><span>{item.label}</span>
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
          <div className="section-head">
            <div><h2>连接检查</h2><p>远程客户端所需参数</p></div>
            <ShieldCheck size={18} />
          </div>
          <dl className="connection-facts">
            <div><dt>传输</dt><dd>Streamable HTTP</dd></div>
            <div><dt>鉴权</dt><dd>Authorization: Bearer</dd></div>
            <div><dt>会话</dt><dd>Stateless</dd></div>
            <div><dt>端点</dt><dd><code>/mcp</code></dd></div>
          </dl>
        </section>
        <section className="panel env-callout">
          <KeyRound size={18} />
          <div><strong>RELAYDOCK_API_KEY</strong><p>在 Agents 页面创建，原始值只显示一次。</p></div>
        </section>
      </aside>
    </div>
  );
}

