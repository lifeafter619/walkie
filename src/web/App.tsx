import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Activity, Code2, EllipsisVertical, KeyRound, LayoutDashboard, LoaderCircle, LogOut, Radio, Menu,
  MessageCircleQuestion, MessageSquareText, RefreshCw, Route as RouteIcon, ServerCog, X
} from 'lucide-react';
import type { ApiKey, Channel, DashboardStats, Delivery, Destination, ProviderDefinition, Route } from '../shared/types';
import { api, ApiError, getToken, setToken } from './api';
import { Button, IconButton, ThemeToggle, Toasts, type Notify, type Toast } from './components/ui';
import { Login } from './components/Login';
import { Overview } from './components/Overview';
import { Channels } from './components/Channels';
import { Routes } from './components/Routes';
import { Deliveries } from './components/Deliveries';
import { Conversations } from './components/Conversations';
import { Keys } from './components/Keys';
import { Integrations } from './components/Integrations';
import { SystemPage } from './components/SystemPage';

type Page = 'overview' | 'channels' | 'routes' | 'deliveries' | 'conversations' | 'keys' | 'integrations' | 'system';
type Meta = Awaited<ReturnType<typeof api.meta>>;

const nav: Array<{ id: Page; label: string; icon: typeof Radio }> = [
  { id: 'overview', label: '概览', icon: LayoutDashboard },
  { id: 'channels', label: '频道', icon: MessageSquareText },
  { id: 'routes', label: '路由', icon: RouteIcon },
  { id: 'deliveries', label: '投递', icon: Activity },
  { id: 'conversations', label: '会话', icon: MessageCircleQuestion },
  { id: 'keys', label: '密钥', icon: KeyRound },
  { id: 'integrations', label: '接入', icon: Code2 },
  { id: 'system', label: '系统', icon: ServerCog }
];

const mobileNav: Page[] = ['overview', 'channels', 'deliveries', 'conversations', 'keys'];

/** 从 location.hash 恢复页面，刷新/前进后退不丢位置 */
const pageFromHash = (): Page => {
  const hash = window.location.hash.replace('#', '');
  return nav.some((item) => item.id === hash) ? (hash as Page) : 'overview';
};

export default function App() {
  const [meta, setMeta] = useState<Meta>();
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState<Page>(pageFromHash);
  const [menu, setMenu] = useState(false);
  // 手机端「更多」底部面板：底栏只放 5 个高频页，其余页面与主题/刷新/退出收纳于此
  const [sheet, setSheet] = useState(false);

  const [stats, setStats] = useState<DashboardStats>();
  const [providers, setProviders] = useState<ProviderDefinition[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [pendingConversations, setPendingConversations] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);

  // 浏览器前进/后退与手输 hash 同步页面
  useEffect(() => {
    const onHash = () => { setPage(pageFromHash()); setSheet(false); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = useCallback((next: Page) => {
    window.location.hash = next;
    setPage(next);
    setSheet(false);
  }, []);

  const notify: Notify = useCallback((kind, message) => {
    const id = Date.now() + Math.random();
    setToasts((old) => [...old, { id, kind, message }]);
    // 错误多留一会儿，读得完
    window.setTimeout(() => setToasts((old) => old.filter((toast) => toast.id !== id)), kind === 'error' ? 6500 : 3500);
  }, []);

  // 投递页状态筛选提升到 App：30s 轮询与手动刷新都沿用当前筛选，避免无筛选全量数据覆盖列表。
  // ref 供 loadAll 取值（不进 useCallback deps，避免改筛选让引导 effect 重跑）；state 供 Deliveries 受控渲染
  const [deliveryFilter, setDeliveryFilter] = useState('');
  const deliveryFilterRef = useRef('');
  const changeDeliveryFilter = useCallback((status: string) => {
    deliveryFilterRef.current = status;
    setDeliveryFilter(status);
  }, []);

  const loadAll = useCallback(async (quiet = false) => {
    try {
      const [nextStats, channelData, routeData, keyData, deliveryData, destinationData, providerData, conversationData] = await Promise.all([
        api.stats(), api.channels(), api.routes(), api.keys(),
        api.deliveries(deliveryFilterRef.current), api.destinations(), api.providers(), api.conversations(true)
      ]);
      setStats(nextStats);
      setChannels(channelData.channels);
      setRoutes(routeData.routes);
      setKeys(keyData.keys);
      setDeliveries(deliveryData.deliveries);
      setDestinations(destinationData.destinations);
      setProviders(providerData.providers);
      setPendingConversations(conversationData.conversations.length);
      setAuthenticated(true);
    } catch (error) {
      if (error instanceof ApiError && (error.status === 401 || error.status === 403)) setAuthenticated(false);
      else {
        // 非鉴权失败（瞬时 500/网络抖动）不把已登录用户踢回登录页：带着现有数据进主界面并提示
        setAuthenticated(true);
        if (!quiet) notify('error', error instanceof Error ? error.message : '加载失败');
      }
    } finally {
      setLoading(false);
    }
  }, [notify]);

  const [metaFailed, setMetaFailed] = useState(false);
  const boot = useCallback(() => {
    setMetaFailed(false);
    setLoading(true);
    api.meta().then(async (nextMeta) => {
      setMeta(nextMeta);
      if (!nextMeta.adminAuthRequired || getToken()) await loadAll();
      else setLoading(false);
    }).catch((error: Error) => { setMetaFailed(true); notify('error', error.message); setLoading(false); });
  }, [loadAll, notify]);

  useEffect(() => { boot(); }, [boot]);

  const refresh = useCallback(() => loadAll(), [loadAll]);

  // 30s 静默轮询保持数据新鲜；页面切后台暂停，恢复可见立即拉取一次
  useEffect(() => {
    if (!authenticated) return;
    const timer = window.setInterval(() => { if (!document.hidden) void loadAll(true); }, 30_000);
    const onVisible = () => { if (!document.hidden) void loadAll(true); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [authenticated, loadAll]);

  // 投递列表轻量轮询（Deliveries 页内有未终结投递时调用，quiet 避免轮询失败刷 toast）
  const refreshDeliveries = useCallback(async (status = '', quiet = false) => {
    try {
      setDeliveries((await api.deliveries(status)).deliveries);
    } catch (error) {
      if (!quiet) notify('error', error instanceof Error ? error.message : '加载失败');
    }
  }, [notify]);

  // Toasts 在三个分支都要渲染：启动/登录期间的错误提示否则完全不可见
  const toastStack = <Toasts toasts={toasts} dismiss={(id) => setToasts((old) => old.filter((item) => item.id !== id))} />;

  if (loading || !meta) {
    return (
      <div className="boot">
        {metaFailed ? (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <p style={{ margin: 0, fontSize: 14 }}>无法连接服务器，请检查网络后重试。</p>
            <Button variant="primary" icon={RefreshCw} onClick={boot}>重试</Button>
          </div>
        ) : (
          <LoaderCircle className="spin" size={20} />
        )}
        {toastStack}
      </div>
    );
  }
  if (!authenticated) return <><Login meta={meta} onSuccess={loadAll} />{toastStack}</>;

  const content = page === 'overview'
    ? <Overview stats={stats} deliveries={deliveries} destinations={destinations} refresh={refresh} notify={notify} />
    : page === 'channels'
    ? <Channels channels={channels} providers={providers} refresh={refresh} notify={notify} />
    : page === 'routes'
    ? <Routes routes={routes} channels={channels} refresh={refresh} notify={notify} />
    : page === 'deliveries'
    ? <Deliveries deliveries={deliveries} refresh={refreshDeliveries} notify={notify} filterStatus={deliveryFilter} onFilterChange={changeDeliveryFilter} />
    : page === 'conversations'
    ? <Conversations notify={notify} onChanged={refresh} />
    : page === 'keys'
    ? <Keys keys={keys} destinations={destinations} refresh={refresh} notify={notify} />
    : page === 'integrations'
    ? <Integrations meta={meta} keys={keys} notify={notify} />
    : <SystemPage meta={meta} channels={channels} providers={providers} refresh={refresh} notify={notify} />;

  return (
    <div className="app-shell">
      <aside className={menu ? 'open' : ''}>
        <div className="brand">
          <span className="brand-mark"><Radio size={14} /></span>
          <strong>Walkie</strong>
          <IconButton label="关闭菜单" icon={X} onClick={() => setMenu(false)} />
        </div>
        <nav>
          {nav.map(({ id, label, icon: Icon }) => (
            <button key={id} className={page === id ? 'active' : ''} onClick={() => { go(id); setMenu(false); }}>
              <Icon size={16} /><span>{label}</span>
              {id === 'deliveries' && stats?.failed24h ? <i>{stats.failed24h}</i> : null}
              {id === 'conversations' && pendingConversations ? <i className="nav-pending">{pendingConversations}</i> : null}
            </button>
          ))}
        </nav>
        <div className="side-footer">
          <div className="side-footer-meta">
            <span className="version-badge" title={`Walkie v${meta.version} · ${meta.runtime}`}>v{meta.version}</span>
            <button
              type="button"
              className="logout-button"
              onClick={() => { setToken(''); setAuthenticated(false); }}
            >
              <LogOut size={13} />
              退出登录
            </button>
          </div>
          <div className="side-footer-actions">
            <ThemeToggle />
            <IconButton label="刷新数据" icon={RefreshCw} onClick={refresh} />
          </div>
        </div>
      </aside>
      {menu && <div className="nav-backdrop" onClick={() => setMenu(false)} />}

      <main className="workspace">
        <header className="mobile-top">
          <IconButton label="打开菜单" icon={Menu} onClick={() => setMenu(true)} />
          <span className="mobile-brand">Walkie</span>
        </header>
        <div className="page-content">{content}</div>
      </main>

      <nav className="mobile-nav">
        {nav.filter(({ id }) => mobileNav.includes(id)).map(({ id, label, icon: Icon }) => (
          <button key={id} className={page === id ? 'active' : ''} onClick={() => go(id)}>
            <span className="mobile-tab-icon">
              <Icon size={19} />
              {id === 'conversations' && pendingConversations ? <i className="mobile-dot" /> : null}
            </span>
            <span>{label}</span>
          </button>
        ))}
        <button
          className={sheet || ['routes', 'integrations', 'system'].includes(page) ? 'active' : ''}
          aria-expanded={sheet}
          onClick={() => setSheet(!sheet)}
        >
          <span className="mobile-tab-icon"><EllipsisVertical size={19} /></span>
          <span>更多</span>
        </button>
      </nav>

      {sheet && (
        <div className="sheet-backdrop" onClick={() => setSheet(false)}>
          <nav className="mobile-sheet" role="dialog" aria-label="更多页面与设置" onClick={(event) => event.stopPropagation()}>
            <div className="sheet-grab" aria-hidden="true" />
            <div className="sheet-links">
              {nav.filter(({ id }) => !mobileNav.includes(id)).map(({ id, label, icon: Icon }) => (
                <button key={id} className={page === id ? 'active' : ''} onClick={() => go(id)}>
                  <Icon size={17} /><span>{label}</span>
                </button>
              ))}
            </div>
            <ThemeToggle />
            <div className="sheet-actions">
              <IconButton label="刷新数据" icon={RefreshCw} onClick={refresh} />
              <span className="version-badge" title={`Walkie v${meta.version} · ${meta.runtime}`}>v{meta.version}</span>
              <button type="button" className="logout-button" onClick={() => { setToken(''); setAuthenticated(false); }}>
                <LogOut size={13} />
                退出登录
              </button>
            </div>
          </nav>
        </div>
      )}

      <Toasts toasts={toasts} dismiss={(id) => setToasts((old) => old.filter((item) => item.id !== id))} />
    </div>
  );
}
