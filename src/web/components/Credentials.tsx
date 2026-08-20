import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, Check, KeyRound, LoaderCircle, RefreshCw, RotateCcw, ShieldCheck, Trash2 } from 'lucide-react';
import type { AdminToken, CredentialStatus } from '../../shared/types';
import { ApiError, api, setToken } from '../api';
import { Button, IconButton, Modal, type Notify, formatDate } from './ui';

/* ────────────────────────────────────────────────────────────
 * 实例凭据区块（「密钥」页下半）：多管理密码、主密钥(KEK/DEK)轮换。
 *
 * 关键约束（诚实声明，写入 UI）：
 * - env ADMIN_TOKEN / MASTER_KEY 是不可变环境密钥，面板无法改写它们本身；
 *   设置的新密码与旧 env 令牌并存（直到重新部署移除 env 值）。
 * - 主密钥「轮换」生成的是新数据加密密钥(DEK)，会用新 DEK 重新加密所有凭据；
 *   env MASTER_KEY(KEK) 不变，仍需 wrangler secret 才能改根密钥。
 * ──────────────────────────────────────────────────────────── */

export function CredentialPanels({ notify, refresh }: { notify: Notify; refresh: () => void }) {
  const [status, setStatus] = useState<CredentialStatus>();
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [revokeTarget, setRevokeTarget] = useState<AdminToken>();
  const [confirmRotateKey, setConfirmRotateKey] = useState(false);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try { setStatus(await api.credentials()); }
    catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setToken('');
        window.location.reload();
        return;
      }
      setLoadFailed(true);
      notify('error', error instanceof Error ? error.message : '加载凭据状态失败');
    }
  }, [notify]);

  useEffect(() => { void load(); }, [load]);

  const createAdminPassword = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.createAdminToken({ name: name.trim() || undefined, token: password });
      setToken(result.token);
      notify('success', '管理密码已创建，本浏览器已自动切换');
      setName('');
      setPassword('');
      await load();
      refresh();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '设置失败');
    } finally { setBusy(false); }
  };

  const revokeAdminPassword = async () => {
    if (!revokeTarget) return;
    const target = revokeTarget;
    setRevokeTarget(undefined);
    setBusy(true);
    try {
      await api.revokeAdminToken(target.id);
      notify('success', `管理密码「${target.name}」已撤销`);
      await load();
      refresh();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '撤销失败');
    } finally { setBusy(false); }
  };

  const restoreAdminPassword = async (token: AdminToken) => {
    setBusy(true);
    try {
      await api.restoreAdminToken(token.id);
      notify('success', `管理密码「${token.name}」已重新启用`);
      await load();
      refresh();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '启用失败');
    } finally { setBusy(false); }
  };

  const rotateMasterKey = async () => {
    setConfirmRotateKey(false);
    setBusy(true);
    try {
      const result = await api.rotateMasterKey();
      await load();
      notify('success', `数据加密密钥已轮换至 v${result.version}`);
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '轮换失败');
    } finally { setBusy(false); }
  };

  if (!status) return loadFailed
    ? <section className="panel"><div className="modal-body">
        <p className="panel-note" style={{ borderTop: 0 }}>凭据状态加载失败，可能是网络抖动。</p>
        <div className="cred-form"><Button variant="primary" icon={RefreshCw} onClick={() => void load()}>重试加载</Button></div>
      </div></section>
    : <div className="modal-loading"><LoaderCircle className="spin" /></div>;

  return (
    <>
      <section className="panel">
        <div className="section-head">
          <h2>管理密码</h2>
          <span className="credential-count"><ShieldCheck size={14} />{status.admin.activeCount} 个有效</span>
        </div>
        <p className="panel-note">每个管理密码都能登录控制台和访问 <code>/api/admin</code>。明文只在创建时使用，不会存入数据库。</p>
        <div className="admin-token-list">
          {status.admin.envConfigured && (
            <div className="admin-token-row">
              <KeyRound size={16} />
              <span><strong>环境变量 ADMIN_TOKEN</strong><small>部署配置 · 需在平台环境变量中撤销</small></span>
              <span className="state-dot active">有效</span>
            </div>
          )}
          {status.admin.tokens.map((token) => (
            <div className="admin-token-row" key={token.id}>
              <KeyRound size={16} />
              <span>
                <strong>{token.name}</strong>
                <small><code>{token.prefix}</code> · 创建于 {formatDate(token.createdAt)}{token.lastUsedAt ? ` · 最近使用 ${formatDate(token.lastUsedAt)}` : ''}</small>
              </span>
              {token.revokedAt
                ? <><span className="state-dot muted">已撤销</span><IconButton label={`重新启用${token.name}`} icon={RotateCcw} disabled={busy} onClick={() => void restoreAdminPassword(token)} /></>
                : <><span className="state-dot active">有效</span><IconButton label={`撤销${token.name}`} icon={Trash2} disabled={busy} onClick={() => setRevokeTarget(token)} /></>}
            </div>
          ))}
        </div>
        <form className="cred-form" onSubmit={createAdminPassword}>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="名称，例如：运维电脑"
            maxLength={100}
            required
          />
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="输入新管理密码（至少 8 个字符）"
            pattern="[!-~]{8,200}"
            title="至少 8 个字符，仅限字母、数字和符号（不含空格）"
            autoComplete="new-password"
            required
          />
          <Button type="submit" variant="primary" icon={Check} loading={busy} disabled={!name.trim() || password.length < 8}>
            创建管理密码
          </Button>
        </form>
        {status.admin.envConfigured && (
          <p className="cred-note warning-text">
            <AlertTriangle size={14} />
            <span>环境变量令牌始终有效。如需彻底弃用，请在重新部署时移除 ADMIN_TOKEN。</span>
          </p>
        )}
      </section>

      <section className="panel">
        <div className="section-head"><h2>主密钥（数据加密密钥）</h2></div>
        <dl className="cred-meta">
          <div><dt>根密钥指纹(KEK)</dt><dd><code>sha256:{status.masterKey.kekFingerprint}</code></dd></div>
          <div><dt>DEK 版本</dt><dd><code>v{status.masterKey.dekVersion}</code></dd></div>
          <div><dt>上次轮换</dt><dd>{status.masterKey.rotatedAt ? formatDate(status.masterKey.rotatedAt) : '—'}</dd></div>
        </dl>
        <div className="cred-form">
          <Button variant="primary" icon={RefreshCw} loading={busy} onClick={() => setConfirmRotateKey(true)}>
            轮换数据加密密钥
          </Button>
        </div>
        <p className="cred-note">
          <span>轮换会生成新的 DEK 并用其重新加密所有频道凭据与 Agent 密钥（单次原子事务，耗时短暂）。
          根密钥(KEK)即环境变量 MASTER_KEY 不变，仍需 <code>wrangler secret put MASTER_KEY</code> 才能更改。</span>
        </p>
      </section>

      {confirmRotateKey && (
        <Modal title="确认轮换主密钥" onClose={() => setConfirmRotateKey(false)}>
          <div className="modal-body">
            <p>将生成新的数据加密密钥(DEK)，并用它重新加密所有频道凭据与 Agent 密钥。该操作在单次事务内原子完成，期间凭据不会被破坏。</p>
            <p className="warning-text"><AlertTriangle size={14} />根密钥(KEK)不变；要更改根密钥仍需 wrangler secret。</p>
            <footer className="modal-actions">
              <Button onClick={() => setConfirmRotateKey(false)}>取消</Button>
              <Button variant="primary" icon={RefreshCw} loading={busy} onClick={rotateMasterKey}>确认轮换</Button>
            </footer>
          </div>
        </Modal>
      )}

      {revokeTarget && (
        <Modal title="确认撤销管理密码" onClose={() => setRevokeTarget(undefined)}>
          <div className="modal-body">
            <p>撤销「{revokeTarget.name}」后，使用该密码的浏览器和 API 客户端将无法继续访问。此操作不可恢复。</p>
            <footer className="modal-actions">
              <Button onClick={() => setRevokeTarget(undefined)}>取消</Button>
              <Button variant="danger" icon={Trash2} loading={busy} onClick={revokeAdminPassword}>确认撤销</Button>
            </footer>
          </div>
        </Modal>
      )}
    </>
  );
}
