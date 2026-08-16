import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import {
  AlertTriangle, Check, CheckCircle2, LoaderCircle, Monitor, Moon, Sun,
  X, type LucideIcon
} from 'lucide-react';
import { setTheme, useTheme } from '../appearance';

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
  // 默认 type="button"：IconButton 常出现在 <form> 内（弹框关闭钮等），不显式指定会变成 submit
  return (
    <button className="icon-button" type="button" title={label} aria-label={label} {...props}>
      <Icon size={16} className={spin ? 'spin' : undefined} />
    </button>
  );
}

export function ThemeToggle() {
  const theme = useTheme();
  const options: Array<{ mode: 'light' | 'dark' | 'system'; label: string; icon: LucideIcon }> = [
    { mode: 'light', label: '亮色', icon: Sun },
    { mode: 'dark', label: '暗色', icon: Moon },
    { mode: 'system', label: '自动', icon: Monitor },
  ];
  return (
    <div className="theme-segment" role="group" aria-label="主题模式">
      {options.map(({ mode, label, icon: Icon }) => (
        <button
          key={mode}
          className={theme === mode ? 'active' : ''}
          title={label}
          aria-label={label}
          aria-pressed={theme === mode}
          onClick={() => setTheme(mode)}
        >
          <Icon size={14} />
          <span>{label}</span>
        </button>
      ))}
    </div>
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

/** 打开中的 Modal 栈：Esc 只关最顶层，避免叠加弹框（频道表单 + 渠道选择器）一次全被关掉 */
const modalStack: symbol[] = [];

export function Modal({
  title, children, onClose, wide = false
}: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  // onClose 走 ref、注册只在挂载时做一次：若把 onClose 放进 deps，父组件每次重渲染
  // （内联箭头函数变身份）都会让 token 出栈再入栈，叠层顺序被打乱，Esc 会关错层
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const token = Symbol('modal');
    modalStack.push(token);
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || modalStack[modalStack.length - 1] !== token) return;
      closeRef.current();
    };
    window.addEventListener('keydown', close);
    return () => {
      const index = modalStack.indexOf(token);
      if (index >= 0) modalStack.splice(index, 1);
      window.removeEventListener('keydown', close);
    };
  }, []);
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
  // 非法日期字符串会让 Intl.format 抛 RangeError 并击穿整棵组件树，降级为占位符
  if (Number.isNaN(parsed.getTime())) return '—';
  const sameYear = parsed.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat('zh-CN', {
    ...(sameYear ? {} : { year: 'numeric' }),
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(parsed);
};

export const slugify = (value: string) =>
  value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

export { Check, AlertTriangle, LoaderCircle };
