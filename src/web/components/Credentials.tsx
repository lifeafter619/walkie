import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AlertTriangle, Check, LoaderCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import type { CredentialStatus } from '../../shared/types';
import { api, setToken } from '../api';
import { Button, Modal, type Notify, formatDate } from './ui';

/* ────────────────────────────────────────────────────────────
 * 实例凭据区块（「密钥」页下半）：管理密码设置、主密钥(KEK/DEK)轮换。
 *
 * 管理密码像普通密码一样：自己输入一个（≥8 字符）即可，保存后本浏览器
 * 自动切换到新密码，无需重新登录。
 *
 * 关键约束（诚实声明，写入 UI）：
 * - env ADMIN_TOKEN / MASTER_KEY 是不可变环境密钥，面板无法改写它们本身；
 *   设置的新密码与旧 env 令牌并存（直到重新部署移除 env 值）。
 * - 主密钥「轮换」生成的是新数据加密密钥(DEK)，会用新 DEK 重新加密所有凭据；
 *   env MASTER_KEY(KEK) 不变，仍需 wrangler secret 才能改根密钥。
 * ──────────────────────────────────────────────────────────── */

export function CredentialPanels({ notify, refresh }: { notify: Notify; refresh: () => void }) {
  const [status, setStatus] = useState<CredentialStatus>();
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState('');
  const [confirmRotateKey, setConfirmRotateKey] = useState(false);

  const load = useCallback(async () => {
    try { setStatus(await api.credentials()); }
    catch (error) { notify('error', error instanceof Error ? error.message : '加载凭据状态失败'); }
  }, [notify]);

  useEffect(() => { void load(); }, [load]);

  const saveAdminPassword = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.rotateAdminToken({ token: password });
      setToken(password); // 当前浏览器无缝切换到新密码
      notify('success', '管理密码已更新，本浏览器已自动使用新密码');
      setPassword('');
      await load();
      refresh();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '设置失败');
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

  if (!status) return <div className="modal-loading"><LoaderCircle className="spin" /></div>;

  return (
    <>
      <section className="panel">
        <div className="section-head"><h2>管理密码</h2></div>
        <p className="panel-note">登录本控制台与访问 <code>/api/admin</code> 接口的密码，可随时改成任意想要的值。</p>
        <dl className="cred-meta">
          <div>
            <dt>当前来源</dt>
            <dd>
              {status.admin.source === 'env'
                ? <span><ShieldCheck size={15} />环境变量（ADMIN_TOKEN）</span>
                : <span><Check size={15} />已自定义{status.admin.prefix ? <code>{status.admin.prefix}</code> : null}</span>}
            </dd>
          </div>
          <div>
            <dt>环境令牌</dt>
            <dd>{status.admin.envConfigured ? <span className="state-dot active">已配置，仍有效</span> : <span className="muted">未配置</span>}</dd>
          </div>
        </dl>
        <form className="cred-form" onSubmit={saveAdminPassword}>
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
          <Button type="submit" variant="primary" icon={RefreshCw} loading={busy} disabled={password.length < 8}>
            设置管理密码
          </Button>
        </form>
        {status.admin.envConfigured && (
          <p className="cred-note warning-text">
            <AlertTriangle size={14} />
            <span>环境变量中的旧令牌仍然有效。如需彻底弃用，请在重新部署时移除 ADMIN_TOKEN。</span>
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
    </>
  );
}
