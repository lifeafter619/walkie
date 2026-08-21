import { useCallback, useEffect, useState } from 'react';
import { BellRing, LoaderCircle, Trash2 } from 'lucide-react';
import { api } from '../api';
import { Button, IconButton, type Notify, formatDate } from './ui';

/* ────────────────────────────────────────────────────────────
 * Web Push（#6）：在本设备浏览器上订阅本站推送，无需任何第三方账号。
 * 订阅后把 webpush 频道加进路由，通知就会直接落到桌面/手机通知中心。
 * ──────────────────────────────────────────────────────────── */

/** VAPID 公钥是 base64url，pushManager.subscribe 要的是原始字节。
 *  显式 new ArrayBuffer：TS 5.9 起 Uint8Array<ArrayBufferLike> 不再满足 BufferSource */
function applicationServerKey(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - base64url.length % 4) % 4);
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

const shortEndpoint = (endpoint: string) => {
  try {
    const url = new URL(endpoint);
    return `${url.host}…${url.pathname.slice(-12)}`;
  } catch {
    return endpoint.slice(0, 40);
  }
};

export function WebPushPanel({ notify }: { notify: Notify }) {
  const [state, setState] = useState<{ vapidPublicKey: string; subscriptions: Array<{ endpoint: string; createdAt: string }> }>();
  const [busy, setBusy] = useState(false);
  const [thisEndpoint, setThisEndpoint] = useState('');

  // 浏览器能力检测：Safari/iOS 必须先「添加到主屏幕」，http 页面（非 localhost）也没有 SW
  const supported = typeof window !== 'undefined'
    && 'serviceWorker' in navigator && 'PushManager' in window && window.isSecureContext;

  const load = useCallback(async () => {
    try {
      setState(await api.webpush());
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '读取 Web Push 配置失败');
    }
  }, [notify]);

  useEffect(() => { void load(); }, [load]);

  // 本设备当前订阅：用于把「订阅」按钮切成「已订阅」
  useEffect(() => {
    if (!supported) return;
    void navigator.serviceWorker.getRegistration('/')
      .then((registration) => registration?.pushManager.getSubscription())
      .then((subscription) => setThisEndpoint(subscription?.endpoint ?? ''))
      .catch(() => undefined);
  }, [supported]);

  const subscribe = async () => {
    if (!state) return;
    setBusy(true);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('浏览器通知权限被拒绝，请在站点设置里允许通知');
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      await navigator.serviceWorker.ready;
      const existing = await registration.pushManager.getSubscription();
      // 换过 VAPID 密钥的旧订阅推不动，先退订再重订
      if (existing) await existing.unsubscribe();
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: applicationServerKey(state.vapidPublicKey)
      });
      await api.subscribeWebpush(subscription.toJSON());
      setThisEndpoint(subscription.endpoint);
      notify('success', '本设备已订阅；把 webpush 频道加入路由即可收到通知');
      await load();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '订阅失败');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (endpoint: string) => {
    setBusy(true);
    try {
      await api.unsubscribeWebpush(endpoint);
      if (endpoint === thisEndpoint) {
        const registration = await navigator.serviceWorker.getRegistration('/').catch(() => undefined);
        await (await registration?.pushManager.getSubscription())?.unsubscribe().catch(() => undefined);
        setThisEndpoint('');
      }
      notify('success', '订阅已移除');
      await load();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '移除失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel webpush-panel">
      <div className="section-head">
        <h2>Web Push</h2>
        <BellRing size={15} className="muted" />
      </div>
      {!supported ? (
        <p className="panel-note" style={{ borderTop: 0 }}>
          当前浏览器或访问方式不支持 Web Push。需要 HTTPS（或 localhost）；iOS Safari 需先把本站「添加到主屏幕」再打开。
        </p>
      ) : !state ? (
        <div className="modal-loading"><LoaderCircle className="spin" /></div>
      ) : (
        <div className="webpush-body">
          <div className="webpush-actions">
            <Button variant="primary" icon={busy ? LoaderCircle : BellRing} loading={busy} disabled={busy} onClick={subscribe}>
              {thisEndpoint ? '重新订阅本设备' : '订阅本设备'}
            </Button>
            <span className="muted">{thisEndpoint ? '本设备已订阅' : '未订阅'} · 共 {state.subscriptions.length} 个设备</span>
          </div>
          {state.subscriptions.length > 0 && (
            <ul className="webpush-list">
              {state.subscriptions.map((item) => (
                <li key={item.endpoint}>
                  <span>
                    <code title={item.endpoint}>{shortEndpoint(item.endpoint)}</code>
                    <small>{item.endpoint === thisEndpoint ? '本设备 · ' : ''}{formatDate(item.createdAt)}</small>
                  </span>
                  <IconButton label="移除订阅" icon={Trash2} disabled={busy} onClick={() => void remove(item.endpoint)} />
                </li>
              ))}
            </ul>
          )}
          <p className="panel-note">
            订阅只存 endpoint 与公钥，载荷按 RFC 8291 端到端加密。收通知还需在「频道」页新建一个 <code>Web Push（本站订阅）</code> 频道，并把它设为目的地。
          </p>
        </div>
      )}
    </section>
  );
}
