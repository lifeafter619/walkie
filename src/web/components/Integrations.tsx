import { useState } from 'react';
import { Bot, Code2, Copy, Eye, EyeOff, KeyRound, Network, SquareTerminal } from 'lucide-react';
import type { ApiKey } from '../../shared/types';
import { api } from '../api';
import { Button, IconButton, Notify } from './ui';

type Meta = {
  version: string;
  runtime: 'node' | 'cloudflare-workers';
  publicUrl: string;
  mcpUrl: string;
};
type Client = 'codex' | 'claude' | 'cursor' | 'generic';

/* ────────────────────────────────────────────────────────────
 * MCP 接入：端点 + 客户端配置片段 + 已有 API Key 快速复制。
 * ──────────────────────────────────────────────────────────── */

function maskSecret(secret: string): string {
  if (secret.length <= 12) return secret.slice(0, 4) + '••••';
  return secret.slice(0, 8) + '••••' + secret.slice(-4);
}

export function Integrations({ meta, keys, notify }: { meta: Meta; keys: ApiKey[]; notify: Notify }) {
  const [client, setClient] = useState<Client>('codex');
  const [revealedIds, setRevealedIds] = useState<Set<string>>(new Set());

  const snippets = {
    codex: {
      label: 'Codex', path: '~/.codex/config.toml', icon: SquareTerminal,
      content: `[mcp_servers.walkie]\nurl = "${meta.mcpUrl}"\nbearer_token_env_var = "WALKIE_API_KEY"\ndefault_tools_approval_mode = "writes"`
    },
    claude: {
      label: 'Claude Code', path: '.mcp.json', icon: Bot,
      content: JSON.stringify({ mcpServers: { walkie: { type: 'http', url: meta.mcpUrl, headers: { Authorization: 'Bearer ${WALKIE_API_KEY}' } } } }, null, 2)
    },
    cursor: {
      label: 'Cursor', path: '.cursor/mcp.json', icon: Code2,
      content: JSON.stringify({ mcpServers: { walkie: { url: meta.mcpUrl, headers: { Authorization: 'Bearer ${env:WALKIE_API_KEY}' } } } }, null, 2)
    },
    generic: {
      label: '通用 MCP', path: 'Streamable HTTP', icon: Network,
      content: JSON.stringify({ transport: 'streamable-http', url: meta.mcpUrl, headers: { Authorization: 'Bearer <Agent API Key>' } }, null, 2)
    }
  } as const;

  const selected = snippets[client];
  const copy = async (value: string, message: string) => {
    try {
      await navigator.clipboard.writeText(value);
      notify('success', message);
    } catch {
      notify('error', '复制失败，请手动选择文本');
    }
  };

  const toggleReveal = (id: string) => {
    setRevealedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const activeKeys = keys.filter((key) => !key.revokedAt);

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

          <section className="panel api-keys-list">
            <div className="section-head">
              <h2>Agent API Keys</h2>
              <KeyRound size={15} className="muted" />
            </div>
            {activeKeys.length ? (
              <div className="keys-quick-copy">
                {activeKeys.map((key) => {
                  const revealed = revealedIds.has(key.id) && key.viewable && key.secret;
                  const display = revealed ? key.secret! : (key.secret && key.viewable ? maskSecret(key.secret) : `rdk_${key.prefix}_••••`);
                  return (
                    <div className="key-copy-row" key={key.id}>
                      <div className="key-copy-info">
                        <strong>{key.name}</strong>
                        <code>{display}</code>
                      </div>
                      <div className="row-actions">
                        {key.viewable && (
                          <IconButton label={revealed ? '隐藏' : '显示'} icon={revealed ? EyeOff : Eye} onClick={() => toggleReveal(key.id)} />
                        )}
                        <IconButton label="复制密钥" icon={Copy} onClick={() => key.secret ? copy(key.secret, `${key.name} 已复制`) : notify('error', '此密钥不可复制')} />
                      </div>
                    </div>
                  );
                })}
                <p className="panel-note" style={{ borderTop: 0, padding: '8px 16px' }}>已显示 {activeKeys.length} 个有效密钥；<a href="#keys">管理全部密钥 →</a></p>
              </div>
            ) : (
              <p className="panel-note" style={{ borderTop: 0 }}>还没有 Agent Key。<a href="#keys">前往密钥页创建 →</a></p>
            )}
          </section>

          <section className="panel env-callout">
            <KeyRound size={17} />
            <div><strong>WALKIE_API_KEY</strong><p>配置片段中用环境变量名代替明文密钥，更安全。</p></div>
          </section>
        </aside>
      </div>
    </>
  );
}
