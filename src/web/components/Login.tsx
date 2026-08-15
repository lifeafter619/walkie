import { useState, type FormEvent } from 'react';
import { AlertTriangle, Eye, EyeOff, LockKeyhole, Radio } from 'lucide-react';
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
        <div className="brand-mark"><Radio size={14} /></div>
        <h1>Walkie</h1>
        <p className="login-copy">输入管理密码进入控制台。</p>
        <form onSubmit={submit}>
          <label>
            管理密码
            <div className="password-input">
              <input
                autoComplete="current-password" autoFocus
                type={show ? 'text' : 'password'}
                value={token}
                onChange={(event) => setValue(event.target.value)}
                placeholder="管理密码" required
              />
              <IconButton type="button" label={show ? '隐藏密码' : '显示密码'} icon={show ? EyeOff : Eye} onClick={() => setShow(!show)} />
            </div>
          </label>
          {error && (
            <div className="inline-error"><AlertTriangle size={15} />{error}</div>
          )}
          <Button type="submit" variant="primary" loading={busy} icon={LockKeyhole}>进入控制台</Button>
        </form>
        <footer>Walkie {meta.version}</footer>
      </section>
    </main>
  );
}
