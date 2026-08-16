import { useState, type FormEvent } from 'react';
import { AlertTriangle, ArrowRight, Eye, EyeOff, Radio } from 'lucide-react';
import { api, ApiError, getToken, setToken } from '../api';
import { Button, IconButton } from './ui';

type Meta = Awaited<ReturnType<typeof api.meta>>;

export function Login({ meta, onSuccess }: { meta: Meta; onSuccess: () => void }) {
  const [token, setValue] = useState(getToken());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [show, setShow] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setToken(token.trim());
    try {
      await api.session();
      onSuccess();
    } catch (err) {
      // 仅鉴权失败才清除已存令牌；网络抖动/服务端 5xx 不应吞掉本来有效的密码
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) setToken('');
      setError(err instanceof Error ? err.message : '验证失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-shell">
      <section className="login-brand">
        <div className="login-brand-inner">
          <div className="login-logo"><Radio size={28} /></div>
          <h1>Walkie</h1>
          <p className="login-tagline">AI Agent 与你之间的双向对讲机</p>
          <ul className="login-features">
            <li>
              <strong>MCP · REST · Server酱</strong>
              <span>三种接入方式，一条连接搞定</span>
            </li>
            <li>
              <strong>30+ 通知渠道</strong>
              <span>Telegram · 企微 · 飞书 · Bark · ntfy …</span>
            </li>
            <li>
              <strong>凭据加密存储</strong>
              <span>DEK/KEK 双层加密，密钥不出服务器</span>
            </li>
          </ul>
        </div>
      </section>
      <section className="login-form-side">
        <form className="login-form" onSubmit={submit}>
          <div className="login-form-head">
            <h2>进入控制台</h2>
            <p>输入管理密码以继续。</p>
          </div>
          <label>
            <span className="login-field-label">管理密码</span>
            <div className="password-input">
              <input
                autoComplete="current-password" autoFocus
                type={show ? 'text' : 'password'}
                value={token}
                onChange={(event) => setValue(event.target.value)}
                placeholder="输入管理密码" required
              />
              <IconButton type="button" label={show ? '隐藏密码' : '显示密码'} icon={show ? EyeOff : Eye} onClick={() => setShow(!show)} />
            </div>
          </label>
          {error && (
            <div className="inline-error"><AlertTriangle size={15} />{error}</div>
          )}
          <Button type="submit" variant="primary" loading={busy} icon={ArrowRight}>进入控制台</Button>
          <footer className="login-footer">Walkie v{meta.version} · 自托管通知控制平面</footer>
        </form>
      </section>
    </main>
  );
}
