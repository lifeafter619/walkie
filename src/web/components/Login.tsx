import { useState, type FormEvent } from 'react';
import { AlertTriangle, BellRing, Eye, EyeOff, LockKeyhole } from 'lucide-react';
import { api, getToken, setToken } from '../api';
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
      setToken('');
      setError(err instanceof Error ? err.message : '验证失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="brand-mark large"><BellRing size={25} /></div>
        <p className="eyebrow">RELAYDOCK / ADMIN</p>
        <h1>连接通知控制台</h1>
        <p className="login-copy">输入该实例的管理令牌。</p>
        <form onSubmit={submit}>
          <label>
            管理令牌
            <div className="password-input">
              <input
                autoComplete="current-password" autoFocus
                type={show ? 'text' : 'password'}
                value={token}
                onChange={(event) => setValue(event.target.value)}
                placeholder="ADMIN_TOKEN" required
              />
              <IconButton type="button" label={show ? '隐藏令牌' : '显示令牌'} icon={show ? EyeOff : Eye} onClick={() => setShow(!show)} />
            </div>
          </label>
          {error && (
            <div className="inline-error"><AlertTriangle size={15} />{error}</div>
          )}
          <Button type="submit" variant="primary" loading={busy} icon={LockKeyhole}>进入控制台</Button>
        </form>
        <footer>RelayDock {meta.version}</footer>
      </section>
    </main>
  );
}
