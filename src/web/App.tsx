import { useCallback, useEffect, useState } from 'react';
import {
  Activity, BellRing, Code2, KeyRound, LayoutDashboard, LoaderCircle, Menu,
  MessageSquareText, RefreshCw, Route as RouteIcon, ServerCog, X
} from 'lucide-react';
import type { ApiKey, Channel, DashboardStats, Delivery, Destination, ProviderDefinition, Route } from '../shared/types';
import { api, getToken } from './api';
import { IconButton, ThemeToggle, Toasts, type Notify, type Toast } from './components/ui';
import { Login } from './components/Login';
import { Overview } from './components/Overview';
import { Channels } from './components/Channels';
import { Routes } from './components/Routes';
import { Deliveries } from './components/Deliveries';
import { Keys } from './components/Keys';
import { Integrations } from './components/Integrations';
import { SystemPage } from './components/SystemPage';

type Page = 'overview' | 'channels' | 'routes' | 'deliveries' | 'keys' | 'integrations' | 'system';
type Meta = Awaited<ReturnType<typeof api.meta>>;

const nav: Array<{ id: Page; label: string; icon: typeof BellRing }> = [
  { id: 'overview', label: '概览', icon: LayoutDashboard },
  { id: 'channels', label: '频道', icon: MessageSquareText },
  { id: 'routes', label: '路由', icon: RouteIcon },
  { id: 'deliveries', label: '投递', icon: Activity },
  { id: 'keys', label: '密钥', icon: KeyRound },
  { id: 'integrations', label: '接入', icon: Code2 },
  { id: 'system', label: '系统', icon: ServerCog }
];

const mobileNav: Page[] = ['overview', 'channels', 'deliveries', 'keys', 'integrations'];

export default function App() {
  const [meta, setMeta] = useState<Meta>();
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState<Page>('overview');
  const [menu, setMenu] = useState(false);

  const [stats, setStats] = useState<DashboardStats>();
  const [providers, setProviders] = useState<ProviderDefinition[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [deliveries, setDeliveries] = useState<Delivery[]>([]);
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const notify: Notify = useCallback((kind, message) => {
    const id = Date.now() + Math.random();
    setToasts((old) => [...old, { id, kind, message }]);
    window.setTimeout(() => setToasts((old) => old.filter((toast) => toast.id !== id)), 4000);
  }, []);

  const loadAll = useCallback(async () => {
    try {
      const [nextStats, channelData, routeData, keyData, deliveryData, destinationData, providerData] = await Promise.all([
        api.stats(), api.channels(), api.routes(), api.keys(),
        api.deliveries(), api.destinations(), api.providers()
      ]);
      setStats(nextStats);
      setChannels(channelData.channels);
      setRoutes(routeData.routes);
      setKeys(keyData.keys);
      setDeliveries(deliveryData.deliveries);
      setDestinations(destinationData.destinations);
      setProviders(providerData.providers);
      setAuthenticated(true);
    } catch (error) {
      if ((error instanceof Error ? error.message : '').includes('令牌')) setAuthenticated(false);
      else notify('error', error instanceof Error ? error.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    api.meta().then(async (nextMeta) => {
      setMeta(nextMeta);
      if (!nextMeta.adminAuthRequired || getToken()) await loadAll();
      else setLoading(false);
    }).catch((error: Error) => { notify('error', error.message); setLoading(false); });
  }, [loadAll, notify]);

  const refresh = useCallback(() => void loadAll(), [loadAll]);

  // 投递列表轻量轮询：仅当停留在投递页且有未终结投递时（替代无意义的 LIVE 标记）
  const refreshDeliveries = useCallback(async (status = '') => {
    try {
      setDeliveries((await api.deliveries(status)).deliveries);
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '加载失败');
    }
  }, [notify]);

  if (loading || !meta) {
    return <div className="boot"><LoaderCircle className="spin" size={20} /></div>;
  }
  if (!authenticated) return <Login meta={meta} onSuccess={loadAll} />;

  const content = page === 'overview'
    ? <Overview stats={stats} deliveries={deliveries} destinations={destinations} refresh={refresh} notify={notify} />
    : page === 'channels'
    ? <Channels channels={channels} providers={providers} refresh={refresh} notify={notify} />
    : page === 'routes'
    ? <Routes routes={routes} channels={channels} refresh={refresh} notify={notify} />
    : page === 'deliveries'
    ? <Deliveries deliveries={deliveries} refresh={refreshDeliveries} notify={notify} />
    : page === 'keys'
    ? <Keys keys={keys} destinations={destinations} refresh={refresh} notify={notify} />
    : page === 'integrations'
    ? <Integrations meta={meta} notify={notify} />
    : <SystemPage meta={meta} providers={providers} />;

  return (
    <div className="app-shell">
      <aside className={menu ? 'open' : ''}>
        <div className="brand">
          <span className="brand-mark"><BellRing size={14} /></span>
          <strong>RelayDock</strong>
          <IconButton label="关闭菜单" icon={X} onClick={() => setMenu(false)} />
        </div>
        <nav>
          {nav.map(({ id, label, icon: Icon }) => (
            <button key={id} className={page === id ? 'active' : ''} onClick={() => { setPage(id); setMenu(false); }}>
              <Icon size={16} /><span>{label}</span>
              {id === 'deliveries' && stats?.failed24h ? <i>{stats.failed24h}</i> : null}
            </button>
          ))}
        </nav>
        <div className="side-footer">
          <ThemeToggle />
          <IconButton label="刷新数据" icon={RefreshCw} onClick={refresh} />
        </div>
      </aside>
      {menu && <div className="nav-backdrop" onClick={() => setMenu(false)} />}

      <main className="workspace">
        <header className="mobile-top">
          <IconButton label="打开菜单" icon={Menu} onClick={() => setMenu(true)} />
          <span className="mobile-brand">RelayDock</span>
        </header>
        <div className="page-content">{content}</div>
      </main>

      <nav className="mobile-nav">
        {nav.filter(({ id }) => mobileNav.includes(id)).map(({ id, label, icon: Icon }) => (
          <button key={id} className={page === id ? 'active' : ''} onClick={() => setPage(id)}>
            <Icon size={19} /><span>{label}</span>
          </button>
        ))}
      </nav>

      <Toasts toasts={toasts} dismiss={(id) => setToasts((old) => old.filter((item) => item.id !== id))} />
    </div>
  );
}
