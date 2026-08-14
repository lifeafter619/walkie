import { useEffect, type ButtonHTMLAttributes, type ReactNode } from 'react';
import {
  AlertTriangle, Check, CheckCircle2, Clock3, LoaderCircle,
  X, XCircle, type LucideIcon
} from 'lucide-react';

/* ────────────────────────────────────────────────────────────
 * 通用 UI 组件（从原 App.tsx 抽出，供各页面复用）。
 * 保持与原视觉一致，仅做可读性整理 + bug 修正。
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
      {loading ? <LoaderCircle className="spin" size={16} /> : Icon ? <Icon size={16} /> : null}
      {children}
    </button>
  );
}

export function IconButton({
  label, icon: Icon, ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; icon: LucideIcon }) {
  return (
    <button className="icon-button" title={label} aria-label={label} {...props}>
      <Icon size={17} />
    </button>
  );
}

export { ThemeToggle, AppearanceControls } from './AppearanceControls';

export function Badge({ status }: { status: string }) {
  const Icon: LucideIcon =
    ['delivered', 'success'].includes(status) ? CheckCircle2
    : status === 'failed' ? XCircle
    : ['processing', 'sending', 'retrying'].includes(status) ? LoaderCircle
    : Clock3;
  return (
    <span className={`badge badge-${status}`}>
      <Icon size={13} className={status === 'sending' || status === 'processing' ? 'spin' : ''} />
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export const STATUS_LABEL: Record<string, string> = {
  queued: '排队中', processing: '发送中', delivered: '已送达', partial: '部分送达', failed: '失败',
  pending: '等待', sending: '发送中', retrying: '重试中', skipped: '已跳过',
  success: '正常', revoked: '已吊销'
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
      <span><Icon size={22} /></span>
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
          {toast.kind === 'success' ? <CheckCircle2 size={18} /> : <AlertTriangle size={18} />}
          <span>{toast.message}</span>
          <IconButton label="关闭" icon={X} onClick={() => dismiss(toast.id)} />
        </div>
      ))}
    </div>
  );
}

export const formatDate = (date?: string) =>
  date
    ? new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
      }).format(new Date(date))
    : '—';

export const slugify = (value: string) =>
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

export { Check, AlertTriangle, LoaderCircle };
