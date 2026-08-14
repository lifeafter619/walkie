import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, Check, Copy, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import type { CredentialStatus } from '../../shared/types';
import { api } from '../api';
import { Button, IconButton, Modal, type Notify, formatDate } from './ui';

/* ────────────────────────────────────────────────────────────
 * 实例凭据区块（「密钥」页下半）：管理令牌轮换、主密钥(KEK/DEK)轮换。
 *
 * 关键约束（诚实声明，写入 UI）：
 * - env ADMIN_TOKEN / MASTER_KEY 是不可变环境密钥，面板无法改写它们本身；
 *   管理令牌「轮换」生成的是并存的新令牌（旧 env 令牌仍有效，直到重新部署移除）。
 * - 主密钥「轮换」生成的是新数据加密密钥(DEK)，会用新 DEK 重新加密所有凭据；
 *   env MASTER_KEY(KEK) 不变，仍需 wrangler secret 才能改根密钥。
 * ──────────────────────────────────────────────────────────── */

export function CredentialPanels({ notify, refresh }: { notify: Notify; refresh: () => void }) {
  const [status, setStatus] = useState<CredentialStatus>();
  const [busy, setBusy] = useState(false);
  const [customToken, setCustomToken] = useState('');
  const [useCustom, setUseCustom] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const [confirmRotateKey, setConfirmRotateKey] = useState(false);

  const load = useCallback(async () => {
    try { setStatus(await api.credentials()); }
    catch (error) { notify('error', error instanceof Error ? error.message : '加载凭据状态失败'); }
  }, [notify]);

  useEffect(() => { void load(); }, [load]);

  const rotateAdminToken = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const body = useCustom && customToken ? { token: customToken } : {};
      const result = await api.rotateAdminToken(body);
      setNewToken(result.token);
      await load();
      refresh();
      setCustomToken('');
      setUseCustom(false);
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '轮换失败');
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

  const copy = async (value: string) => {
    await navigator.clipboard.writeText(value);
    notify('success', '已复制');
  };

  if (!status) return <div className="modal-loading"><LoaderCircle className="spin" /></div>;

  return (
    <>
      <section className="panel">
        <div className="section-head"><h2>管理令牌</h2></div>
        <p className="panel-note">用于访问本控制台与所有 <code>/api/admin</code> 接口。</p>
        <dl className="cred-meta">
          <div>
            <dt>当前来源</dt>
            <dd>
              {status.admin.source === 'env'
                ? <span><ShieldCheck size={15} />环境变量（ADMIN_TOKEN）</span>
                : <span><Check size={15} />已轮换（数据库）{status.admin.prefix ? <code>{status.admin.prefix}</code> : null}</span>}
            </dd>
          </div>
          <div>
            <dt>环境令牌</dt>
            <dd>{status.admin.envConfigured ? <span className="state-dot active">已配置，仍有效</span> : <span className="warning-text">未配置</span>}</dd>
          </div>
        </dl>
        <form className="cred-form" onSubmit={rotateAdminToken}>
          <label className="inline-toggle">
            <button type="button" className={`switch ${useCustom ? 'on' : ''}`} onClick={() => setUseCustom(!useCustom)}><span /></button>
            <span><strong>使用自定义令牌</strong><small>关闭时由系统随机生成</small></span>
          </label>
          {useCustom && (
            <input
              value={customToken}
              onChange={(event) => setCustomToken(event.target.value)}
              placeholder="至少 24 个字符的自定义令牌"
              minLength={24}
              required
              autoFocus
            />
          )}
          <Button type="submit" variant="primary" icon={RefreshCw} loading={busy} disabled={useCustom && customToken.length < 24}>
            轮换管理令牌
          </Button>
        </form>
        {status.admin.envConfigured && (
          <p className="cred-note warning-text">
            <AlertTriangle size={14} />
            环境变量中的管理令牌仍然有效。如需彻底弃用旧令牌，请在重新部署时移除 ADMIN_TOKEN。
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
          轮换会生成新的 DEK 并用其重新加密所有频道凭据与 Agent 密钥（单次原子事务，耗时短暂）。
          根密钥(KEK)即环境变量 MASTER_KEY 不变，仍需 <code>wrangler secret put MASTER_KEY</code> 才能更改。
        </p>
      </section>

      {newToken && (
        <Modal title="新管理令牌已生成" onClose={() => setNewToken(null)} wide>
          <div className="modal-body secret-screen">
            <div className="warning-banner">
              <AlertTriangle size={18} />
              <div>
                <strong>请立即保存，关闭后无法再查看</strong>
                <p>这是该令牌唯一一次明文展示。请复制并妥善保管。</p>
              </div>
            </div>
            <label>管理令牌
              <div className="copy-field">
                <code>{newToken}</code>
                <IconButton label="复制令牌" icon={Copy} onClick={() => copy(newToken)} />
              </div>
            </label>
            <footer className="modal-actions">
              <Button variant="primary" icon={Check} onClick={() => setNewToken(null)}>我已保存</Button>
            </footer>
          </div>
        </Modal>
      )}

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
    </>
  );
}
