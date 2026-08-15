import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';
import {
  AlertTriangle, Check, CheckCircle2, LoaderCircle, Monitor, Moon, Sun,
  X, type LucideIcon
} from 'lucide-react';
import { cycleTheme, useTheme } from '../appearance';

/* ────────────────────────────────────────────────────────────
 * 通用 UI 组件。中性工具风：状态用小圆点+文字，不用彩色胶囊。
 * ──────────────────────────────────────────────────────────── */

export type Toast = { id: number; kind: 'success' | 'error'; message: string };
export type Notify = (kind: Toast['kind'], message: string) => void;

export function Button({
  children, variant = 'secondary', icon: Icon, loading, ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  icon?: LucideIcon;
  loading?: boolean;
}) {
  return (
    <button className={`button button-${variant}`} {...props} disabled={loading || props.disabled}>
      {loading ? <LoaderCircle className="spin" size={15} /> : Icon ? <Icon size={15} /> : null}
      {children}
    </button>
  );
}

export function IconButton({
  label, icon: Icon, spin, ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: LucideIcon; spin?: boolean }) {
  return (
    <button className="icon-button" title={label} aria-label={label} {...props}>
      <Icon size={16} className={spin ? 'spin' : undefined} />
    </button>
  );
}

export function ThemeToggle() {
  const theme = useTheme();
  const Icon = theme === 'system' ? Monitor : theme === 'dark' ? Moon : Sun;
  const label = theme === 'system' ? '跟随系统' : theme === 'dark' ? '暗色' : '亮色';
  return (
    <button className="icon-button" title={`主题：${label}（点击切换）`} aria-label={`主题：${label}`} onClick={cycleTheme}>
      <Icon size={16} />
    </button>
  );
}

/** 状态展示：小圆点 + 文字。仅失败用红字；sending/processing 用 spinner 代替圆点。 */
export function Badge({ status }: { status: string }) {
  const spinning = status === 'sending' || status === 'processing';
  const tone =
    ['delivered', 'success', 'replied'].includes(status) ? 'ok'
    : status === 'failed' ? 'bad'
    : ['partial', 'retrying'].includes(status) ? 'warn'
    : spinning ? 'info' : 'idle';
  return (
    <span className={`status status-${tone}`}>
      {spinning ? <LoaderCircle size={12} className="spin" /> : <i className="dot" />}
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export const STATUS_LABEL: Record<string, string> = {
  queued: '排队中', processing: '发送中', delivered: '已送达', partial: '部分送达', failed: '失败',
  pending: '等待', sending: '发送中', retrying: '重试中', skipped: '已跳过',
  success: '正常', revoked: '已吊销', replied: '已回复', expired: '已过期'
};

export const SEVERITY_LABEL: Record<'info' | 'success' | 'warning' | 'critical', string> = {
  info: '信息', success: '成功', warning: '警告', critical: '紧急'
};

export function Modal({
  title, children, onClose, wide = false
}: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => event.key === 'Escape' && onClose();
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <IconButton label="关闭" icon={X} onClick={onClose} />
        </header>
        {children}
      </section>
    </div>
  );
}

export function Empty({ icon: Icon, title, text, action }: { icon: LucideIcon; title: string; text: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <Icon size={22} />
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}

export function Toasts({ toasts, dismiss }: { toasts: Toast[]; dismiss: (id: number) => void }) {
  return (
    <div className="toast-stack" aria-live="polite">
      {toasts.map((toast) => (
        <div className={`toast ${toast.kind}`} key={toast.id}>
          {toast.kind === 'success' ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
          <span>{toast.message}</span>
          <IconButton label="关闭" icon={X} onClick={() => dismiss(toast.id)} />
        </div>
      ))}
    </div>
  );
}

export const formatDate = (date?: string) => {
  if (!date) return '—';
  const parsed = new Date(date);
  const sameYear = parsed.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat('zh-CN', {
    ...(sameYear ? {} : { year: 'numeric' }),
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(parsed);
};

export const slugify = (value: string) =>
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

export { Check, AlertTriangle, LoaderCircle };
