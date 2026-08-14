import { useMemo } from 'react';
import { AlertTriangle, Check, ShieldCheck } from 'lucide-react';
import type { ProviderDefinition } from '../../shared/types';

type Meta = {
  version: string;
  runtime: 'node' | 'cloudflare-workers';
  publicUrl: string;
  mcpUrl: string;
  adminAuthRequired: boolean;
};

const CATEGORY_LABEL: Record<string, string> = {
  chat: '聊天协作', push: '移动推送', email: '邮件', sms: '短信', universal: '通用扩展'
};

/* ────────────────────────────────────────────────────────────
 * 系统状态：实例信息、渠道能力、安全边界。
 * MCP 端点只在「接入」页展示，这里不重复。
 * ──────────────────────────────────────────────────────────── */

export function SystemPage({ meta, providers }: { meta: Meta; providers: ProviderDefinition[] }) {
  const categories = useMemo(() => {
    const counts = providers.reduce<Record<string, number>>((acc, item) => {
      acc[item.category] = (acc[item.category] ?? 0) + 1;
      return acc;
    }, {});
    return Object.entries(counts).sort((a, b) => b[1] - a[1]);
  }, [providers]);

  return (
    <>
      <header className="page-head"><h1>系统</h1></header>

      <div className="system-grid">
        <section className="panel system-status">
          <div className="section-head">
            <h2>实例状态</h2>
            <span className="health"><i />运行正常</span>
          </div>
          <dl>
            <div><dt>版本</dt><dd><code>{meta.version}</code></dd></div>
            <div><dt>运行时</dt><dd><code>{meta.runtime === 'cloudflare-workers' ? 'Cloudflare Workers' : 'Node.js'}</code></dd></div>
            <div><dt>管理面板</dt><dd><code>{meta.publicUrl}</code></dd></div>
            <div><dt>MCP Streamable HTTP</dt><dd><code>{meta.mcpUrl}</code></dd></div>
            <div><dt>REST 通知 API</dt><dd><code>{meta.publicUrl}/api/v1/notify</code></dd></div>
            <div><dt>Server酱兼容入口</dt><dd><code>{meta.publicUrl}/send/&lt;AgentKey&gt;.send</code></dd></div>
            <div>
              <dt>管理鉴权</dt>
              <dd>
                {meta.adminAuthRequired
                  ? <span><ShieldCheck size={15} />已启用</span>
                  : <span className="warning-text"><AlertTriangle size={15} />本地免鉴权</span>}
              </dd>
            </div>
          </dl>
        </section>

        <section className="panel provider-summary">
          <div className="section-head"><h2>渠道能力</h2></div>
          <div className="capability-list">
            {categories.map(([category, count]) => (
              <div className="capability-row" key={category}>
                <span className="capability-label">{CATEGORY_LABEL[category] ?? category}</span>
                <span className="capability-count">{count}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="panel security-list">
          <div className="section-head"><h2>安全边界</h2></div>
          <ul>
            <li><Check size={15} /><span><strong>凭据静态加密</strong><small>AES-256-GCM</small></span></li>
            <li><Check size={15} /><span><strong>Agent Key 哈希存储</strong><small>原始值仅显示一次</small></span></li>
            <li><Check size={15} /><span><strong>Webhook SSRF 防护</strong><small>默认禁止 HTTP、私网和回环地址</small></span></li>
            <li><Check size={15} /><span><strong>最小权限</strong><small>Scope 与目的地白名单</small></span></li>
          </ul>
        </section>
      </div>
    </>
  );
}
