import { Fragment, useState, type FormEvent } from 'react';
import { AlertTriangle, Bot, Check, Copy, Eye, EyeOff, KeyRound, Plus, Power } from 'lucide-react';
import type { ApiKey, Destination } from '../../shared/types';
import { api } from '../api';
import { Badge, Button, Empty, IconButton, Modal, Notify, formatDate } from './ui';

/* ────────────────────────────────────────────────────────────
 * Agent 授权：创建/吊销 API Key，权限与目的地白名单。
 * ──────────────────────────────────────────────────────────── */

export function KeyForm({
  destinations, close, saved, notify
}: {
  destinations: Destination[];
  close: () => void;
  saved: () => void;
  notify: Notify;
}) {
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState(['notifications:send', 'deliveries:read']);
  const [restricted, setRestricted] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState('');

  const create = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.createKey({ name, scopes, destinationIds: restricted ? ids : [] });
      setSecret(result.secret);
      saved();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '创建失败');
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    await navigator.clipboard.writeText(secret);
    notify('success', '密钥已复制');
  };

  const SCOPE_OPTIONS = [
    { id: 'notifications:send', label: '发送通知' },
    { id: 'deliveries:read', label: '读取投递状态' }
  ] as const;

  return (
    <Modal title={secret ? '保存 Agent API Key' : '创建 Agent API Key'} onClose={close} wide>
      {secret ? (
        <div className="modal-body secret-screen">
          <div className="warning-banner">
            <AlertTriangle size={18} />
            <div>
              <strong>密钥只显示这一次</strong>
              <p>关闭窗口后无法再次查看，只能吊销并重新创建。</p>
            </div>
          </div>
          <label>Agent API Key
            <div className="copy-field">
              <code>{secret}</code>
              <IconButton label="复制密钥" icon={Copy} onClick={copy} />
            </div>
          </label>
          <footer className="modal-actions">
            <Button variant="primary" icon={Check} onClick={close}>我已保存</Button>
          </footer>
        </div>
      ) : (
        <form className="modal-body" onSubmit={create}>
          <label>名称
            <input autoFocus value={name} onChange={(event) => setName(event.target.value)} required placeholder="CI 发布 Agent" />
          </label>
          <div>
            <div className="field-label">权限范围</div>
            <div className="scope-list">
              {SCOPE_OPTIONS.map((scope) => (
                <label key={scope.id}>
                  <input
                    type="checkbox"
                    checked={scopes.includes(scope.id)}
                    onChange={(event) => setScopes(event.target.checked ? [...scopes, scope.id] : scopes.filter((item) => item !== scope.id))}
                  />
                  <span><strong>{scope.label}</strong><code>{scope.id}</code></span>
                </label>
              ))}
            </div>
          </div>
          <label className="inline-toggle">
            <button type="button" className={`switch ${restricted ? 'on' : ''}`} onClick={() => setRestricted(!restricted)}><span /></button>
            <span><strong>限制可用目的地</strong><small>关闭时可访问全部已启用目的地</small></span>
          </label>
          {restricted && (
            <div className="destination-checks">
              {destinations.filter((item) => item.enabled).map((item) => (
                <label key={item.id}>
                  <input type="checkbox" checked={ids.includes(item.id)} onChange={(event) => setIds(event.target.checked ? [...ids, item.id] : ids.filter((id) => id !== item.id))} />
                  {item.name}<small>{item.kind === 'route' ? '路由' : item.provider}</small>
                </label>
              ))}
            </div>
          )}
          <footer className="modal-actions">
            <Button type="button" onClick={close}>取消</Button>
            <Button type="submit" variant="primary" icon={KeyRound} loading={busy} disabled={!scopes.length || (restricted && !ids.length)}>创建密钥</Button>
          </footer>
        </form>
      )}
    </Modal>
  );
}

export function Agents({
  keys, destinations, refresh, notify
}: {
  keys: ApiKey[];
  destinations: Destination[];
  refresh: () => void;
  notify: Notify;
}) {
  const [creating, setCreating] = useState(false);
  const [revealId, setRevealId] = useState<string | null>(null);

  const revoke = async (key: ApiKey) => {
    if (!confirm(`吊销“${key.name}”？使用该密钥的 Agent 会立即失去访问权限。`)) return;
    try {
      await api.revokeKey(key.id);
      notify('success', '密钥已吊销');
      refresh();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '吊销失败');
    }
  };

  const copySecret = async (secret: string) => {
    await navigator.clipboard.writeText(secret);
    notify('success', '密钥已复制');
  };

  return (
    <>
      <div className="toolbar">
        <div className="toolbar-copy">
          <strong>{keys.filter((key) => !key.revokedAt).length} 个有效密钥</strong>
          <span>鉴权用哈希，明文以加密形式存储，可随时查看复制</span>
        </div>
        <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>创建密钥</Button>
      </div>

      <section className="panel">
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Agent</th><th>密钥前缀</th><th>权限</th><th>目的地</th><th>最近使用</th><th>状态</th><th /></tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <Fragment key={key.id}>
                  <tr className={key.revokedAt ? 'disabled-row' : ''}>
                    <td>
                      <strong className="table-title with-icon"><Bot size={16} />{key.name}</strong>
                      <span className="muted-row">创建于 {formatDate(key.createdAt)}</span>
                    </td>
                    <td><code>rdk_{key.prefix}_••••</code></td>
                    <td>
                      <div className="scope-pills">
                        {key.scopes.map((scope) => <span key={scope}>{scope === 'notifications:send' ? '发送' : '读取'}</span>)}
                      </div>
                    </td>
                    <td>{key.destinationIds.length ? `${key.destinationIds.length} 个指定目的地` : '全部目的地'}</td>
                    <td>{formatDate(key.lastUsedAt)}</td>
                    <td>{key.revokedAt ? <Badge status="revoked" /> : <span className="state-dot active">有效</span>}</td>
                    <td>
                      {!key.revokedAt && key.viewable && (
                        <IconButton label={revealId === key.id ? '收起密钥' : '查看密钥'} icon={revealId === key.id ? EyeOff : Eye} onClick={() => setRevealId(revealId === key.id ? null : key.id)} />
                      )}
                      {!key.revokedAt && <IconButton label="吊销密钥" icon={Power} onClick={() => revoke(key)} />}
                    </td>
                  </tr>
                  {revealId === key.id && (
                    <tr className="reveal-row">
                      <td colSpan={7}>
                        {key.viewable && key.secret ? (
                          <div className="copy-field">
                            <code>{key.secret}</code>
                            <IconButton label="复制密钥" icon={Copy} onClick={() => copySecret(key.secret!)} />
                          </div>
                        ) : (
                          <span className="muted-row">此密钥创建于该功能启用前，仅存哈希，无法查看。如需可复制密钥，请吊销后重新创建。</span>
                        )}
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          {!keys.length && (
            <Empty icon={Bot} title="还没有 Agent Key" text="创建一个密钥，让 Agent 通过 MCP 或 REST 发送通知。" action={<Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>创建密钥</Button>} />
          )}
        </div>
      </section>

      {creating && <KeyForm destinations={destinations} close={() => setCreating(false)} saved={refresh} notify={notify} />}
    </>
  );
}
