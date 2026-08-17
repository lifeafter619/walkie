import { Fragment, useState, type FormEvent } from 'react';
import { AlertTriangle, Bot, Check, Copy, Eye, EyeOff, KeyRound, Plus, Power, RotateCcw, Settings2, Trash2 } from 'lucide-react';
import type { ApiKey, Destination } from '../../shared/types';
import { api } from '../api';
import { Badge, Button, Empty, IconButton, Modal, Notify, formatDate } from './ui';
import { CredentialPanels } from './Credentials';

/* ────────────────────────────────────────────────────────────
 * 密钥页：Agent API Key（创建/查看/吊销）+ 实例凭据（管理令牌/主密钥）。
 * ──────────────────────────────────────────────────────────── */

export function KeyForm({
  destinations, close, saved, notify, editing
}: {
  destinations: Destination[];
  close: () => void;
  saved: () => void;
  notify: Notify;
  editing?: ApiKey;
}) {
  const [name, setName] = useState(editing?.name ?? '');
  const [scopes, setScopes] = useState<string[]>(editing?.scopes ?? ['notifications:send', 'deliveries:read']);
  const [restricted, setRestricted] = useState(Boolean(editing?.destinationIds.length));
  const [ids, setIds] = useState<string[]>(editing?.destinationIds ?? []);
  const [customSecret, setCustomSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState('');

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      if (editing) {
        await api.updateKey(editing.id, { name, scopes, destinationIds: restricted ? ids : [] });
      } else {
        const result = await api.createKey({
          name, scopes, destinationIds: restricted ? ids : [],
          ...(customSecret ? { secret: customSecret } : {})
        });
        setSecret(result.secret);
      }
      saved();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret);
      notify('success', '密钥已复制');
    } catch {
      notify('error', '复制失败，请手动选择文本');
    }
  };

  const SCOPE_OPTIONS = [
    { id: 'notifications:send', label: '发送通知' },
    { id: 'deliveries:read', label: '读取投递状态' },
    { id: 'config:write', label: '配置管理' }
  ] as const;

  return (
    <Modal title={editing ? '编辑 Agent API Key' : secret ? '保存 Agent API Key' : '创建 Agent API Key'} onClose={close} wide>
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
        <form className="modal-body" onSubmit={submit}>
          <label>名称
            <input autoFocus maxLength={100} value={name} onChange={(event) => setName(event.target.value)} required placeholder="CI 发布 Agent" />
          </label>
          {!editing && (
            <label>自定义密钥<span className="optional">可选，留空自动生成</span>
              <input
                value={customSecret}
                onChange={(event) => setCustomSecret(event.target.value)}
                placeholder="像密码一样随意设置，Agent 直接用它鉴权"
                pattern="[!-~]{8,200}"
                title="至少 8 个字符，仅限字母、数字和符号（不含空格）"
                autoComplete="off"
              />
              <small>至少 8 个字符（字母/数字/符号，不含空格）。留空则生成随机 rdk_ 密钥。</small>
            </label>
          )}
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
            <Button type="submit" variant="primary" icon={KeyRound} loading={busy} disabled={!scopes.length || (restricted && !ids.length)}>{editing ? '保存修改' : '创建密钥'}</Button>
          </footer>
        </form>
      )}
    </Modal>
  );
}

export function Keys({
  keys, destinations, refresh, notify
}: {
  keys: ApiKey[];
  destinations: Destination[];
  refresh: () => Promise<void> | void;
  notify: Notify;
}) {
  const [creating, setCreating] = useState(false);
  const [editingKey, setEditingKey] = useState<ApiKey | null>(null);
  const [revealId, setRevealId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [busyId, setBusyId] = useState('');

  const SCOPE_LABELS: Record<string, string> = { 'notifications:send': '发送', 'deliveries:read': '读取', 'config:write': '配置' };

  const revoke = async (key: ApiKey) => {
    if (!confirm(`吊销“${key.name}”？使用该密钥的 Agent 会立即失去访问权限。`)) return;
    setBusyId(key.id + 'revoke');
    try {
      await api.revokeKey(key.id);
      notify('success', '密钥已吊销');
      setRevealId(null);
      await refresh();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '吊销失败');
    } finally {
      setBusyId('');
    }
  };

  const restore = async (key: ApiKey) => {
    if (busyId) return;
    setBusyId(key.id + 'restore');
    try {
      await api.restoreKey(key.id);
      notify('success', '密钥已重新启用');
      await refresh();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '启用失败');
    } finally {
      setBusyId('');
    }
  };

  const confirmDelete = async () => {
    if (!deletingId || busyId) return;
    setBusyId(deletingId + 'delete');
    try {
      await api.deleteKey(deletingId);
      notify('success', '密钥已彻底删除');
      setDeletingId(null);
      await refresh();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '删除失败');
    } finally {
      setBusyId('');
    }
  };

  const copySecret = async (secret: string) => {
    try {
      await navigator.clipboard.writeText(secret);
      notify('success', '密钥已复制');
    } catch {
      notify('error', '复制失败，请手动选择文本');
    }
  };

  return (
    <div className="stack">
      <header className="page-head">
        <div>
          <h1>密钥</h1>
          <p className="page-sub">{keys.filter((key) => !key.revokedAt).length} 个有效 Agent 密钥 · 可自定义或随机生成，随时查看复制</p>
        </div>
        <Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>创建密钥</Button>
      </header>

      <section className="panel keys-table-panel">
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
                      <strong className="table-title">{key.name}</strong>
                      <span className="muted-row">创建于 {formatDate(key.createdAt)}</span>
                    </td>
                    <td><code>{key.secret
                      // 随机密钥由服务端生成，格式恒为 rdk_<prefix>_…；自定义密钥即便以 rdk_ 开头也匹配不上（prefix 是哈希）
                      ? (key.secret.startsWith(`rdk_${key.prefix}_`) ? `rdk_${key.prefix}_••••` : '自定义密钥')
                      : `rdk_${key.prefix}_••••`}</code></td>
                    <td>
                      <div className="scope-pills">
                        {key.scopes.map((scope) => <span key={scope}>{SCOPE_LABELS[scope] ?? scope}</span>)}
                      </div>
                    </td>
                    <td>{key.destinationIds.length ? `${key.destinationIds.length} 个指定目的地` : '全部目的地'}</td>
                    <td>{formatDate(key.lastUsedAt)}</td>
                    <td>{key.revokedAt ? <Badge status="revoked" /> : <span className="state-dot active">有效</span>}</td>
                    <td>
                      {key.revokedAt ? (
                        <div className="row-actions">
                          <IconButton label="重新启用" icon={RotateCcw} spin={busyId === key.id + 'restore'} disabled={Boolean(busyId)} onClick={() => restore(key)} />
                          <IconButton label="彻底删除" icon={Trash2} disabled={Boolean(busyId)} onClick={() => setDeletingId(key.id)} />
                        </div>
                      ) : (
                        <div className="row-actions">
                          <IconButton label="编辑范围" icon={Settings2} disabled={Boolean(busyId)} onClick={() => setEditingKey(key)} />
                          {key.viewable && (
                            <IconButton label={revealId === key.id ? '收起密钥' : '查看密钥'} icon={revealId === key.id ? EyeOff : Eye} onClick={() => setRevealId(revealId === key.id ? null : key.id)} />
                          )}
                          <IconButton label="吊销密钥" icon={Power} spin={busyId === key.id + 'revoke'} disabled={Boolean(busyId)} onClick={() => revoke(key)} />
                        </div>
                      )}
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

      {/* 手机端表格列太多改卡片流（styles.css ≤680px 切换显示），操作与表格行共用一套状态 */}
      <div className="keys-cards">
        {keys.map((key) => (
          <div key={key.id} className={`key-card${key.revokedAt ? ' disabled-row' : ''}`}>
            <div className="key-card-head">
              <div>
                <strong>{key.name}</strong>
                <span className="muted-row">创建于 {formatDate(key.createdAt)}</span>
              </div>
              {key.revokedAt ? <Badge status="revoked" /> : <span className="state-dot active">有效</span>}
            </div>
            <dl className="key-card-facts">
              <div>
                <dt>密钥前缀</dt>
                <dd><code>{key.secret
                  // 随机密钥由服务端生成，格式恒为 rdk_<prefix>_…；自定义密钥即便以 rdk_ 开头也匹配不上（prefix 是哈希）
                  ? (key.secret.startsWith(`rdk_${key.prefix}_`) ? `rdk_${key.prefix}_••••` : '自定义密钥')
                  : `rdk_${key.prefix}_••••`}</code></dd>
              </div>
              <div>
                <dt>权限</dt>
                <dd>{key.scopes.map((scope) => SCOPE_LABELS[scope] ?? scope).join('、')}</dd>
              </div>
              <div>
                <dt>目的地</dt>
                <dd>{key.destinationIds.length ? `${key.destinationIds.length} 个指定` : '全部'}</dd>
              </div>
              <div>
                <dt>最近使用</dt>
                <dd>{formatDate(key.lastUsedAt)}</dd>
              </div>
            </dl>
            {revealId === key.id && (
              key.viewable && key.secret ? (
                <div className="copy-field">
                  <code>{key.secret}</code>
                  <IconButton label="复制密钥" icon={Copy} onClick={() => copySecret(key.secret!)} />
                </div>
              ) : (
                <span className="muted-row">此密钥创建于该功能启用前，仅存哈希，无法查看。如需可复制密钥，请吊销后重新创建。</span>
              )
            )}
            <div className="key-card-actions">
              {key.revokedAt ? (
                <>
                  <Button icon={RotateCcw} loading={busyId === key.id + 'restore'} disabled={Boolean(busyId)} onClick={() => restore(key)}>重新启用</Button>
                  <Button icon={Trash2} disabled={Boolean(busyId)} onClick={() => setDeletingId(key.id)}>彻底删除</Button>
                </>
              ) : (
                <>
                  <Button icon={Settings2} disabled={Boolean(busyId)} onClick={() => setEditingKey(key)}>编辑</Button>
                  {key.viewable && (
                    <Button icon={revealId === key.id ? EyeOff : Eye} onClick={() => setRevealId(revealId === key.id ? null : key.id)}>
                      {revealId === key.id ? '收起' : '查看'}
                    </Button>
                  )}
                  <Button icon={Power} loading={busyId === key.id + 'revoke'} disabled={Boolean(busyId)} onClick={() => revoke(key)}>吊销</Button>
                </>
              )}
            </div>
          </div>
        ))}
        {!keys.length && (
          <Empty icon={Bot} title="还没有 Agent Key" text="创建一个密钥，让 Agent 通过 MCP 或 REST 发送通知。" action={<Button variant="primary" icon={Plus} onClick={() => setCreating(true)}>创建密钥</Button>} />
        )}
      </div>

      <CredentialPanels notify={notify} refresh={refresh} />

      {creating && <KeyForm destinations={destinations} close={() => setCreating(false)} saved={refresh} notify={notify} />}

      {editingKey && (
        <KeyForm
          destinations={destinations}
          close={() => setEditingKey(null)}
          saved={() => { setEditingKey(null); refresh(); }}
          notify={notify}
          editing={editingKey}
        />
      )}

      {deletingId && (
        <Modal title="确认彻底删除" onClose={() => setDeletingId(null)}>
          <div className="modal-body">
            <div className="warning-banner">
              <AlertTriangle size={18} />
              <div>
                <strong>此操作不可恢复</strong>
                <p>删除后该密钥记录将永久消失。已吊销的密钥不会再出现在列表中。确认要继续吗？</p>
              </div>
            </div>
            <footer className="modal-actions">
              <Button onClick={() => setDeletingId(null)}>取消</Button>
              <Button variant="danger" icon={Trash2} loading={Boolean(busyId)} onClick={confirmDelete}>彻底删除</Button>
            </footer>
          </div>
        </Modal>
      )}
    </div>
  );
}
