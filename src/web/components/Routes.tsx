import { useState, type FormEvent } from 'react';
import { ArrowDown, ArrowUp, Check, Edit3, Network, Plus, Route as RouteIcon, Trash2 } from 'lucide-react';
import type { Channel, ProviderId, Route, RouteStrategy } from '../../shared/types';
import { api } from '../api';
import { Button, Empty, IconButton, Modal, Notify, slugify } from './ui';
import { ProviderIcon } from './ProviderIcon';

/* ────────────────────────────────────────────────────────────
 * 路由：并发广播 / 故障转移链。频道选择处用真实渠道图标。
 * ──────────────────────────────────────────────────────────── */

export function RouteForm({
  channels, route, close, saved, notify
}: {
  channels: Channel[];
  route?: Route;
  close: () => void;
  saved: () => void;
  notify: Notify;
}) {
  const [name, setName] = useState(route?.name ?? '');
  const [routeSlug, setSlug] = useState(route?.slug ?? '');
  const [strategy, setStrategy] = useState<RouteStrategy>(route?.strategy ?? 'fanout');
  const [selected, setSelected] = useState<string[]>(route?.channelIds ?? []);
  const [busy, setBusy] = useState(false);

  const toggle = (id: string) => setSelected((old) => old.includes(id) ? old.filter((item) => item !== id) : [...old, id]);
  const move = (index: number, direction: -1 | 1) => setSelected((old) => {
    const next = [...old];
    const target = index + direction;
    if (target < 0 || target >= next.length) return old;
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const body = { name, slug: routeSlug || slugify(name), strategy, channelIds: selected };
      route ? await api.updateRoute(route.id, body) : await api.createRoute(body);
      notify('success', route ? '路由已更新' : '路由已创建');
      saved();
      close();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={route ? '编辑路由' : '新建通知路由'} onClose={close} wide>
      <form className="modal-body" onSubmit={submit}>
        <div className="form-grid">
          <label>名称
            <input autoFocus required value={name} onChange={(event) => { setName(event.target.value); if (!route) setSlug(slugify(event.target.value)); }} placeholder="生产事故通知" />
          </label>
          <label>标识符
            <input required value={routeSlug} onChange={(event) => setSlug(event.target.value)} pattern="[a-z0-9](?:[a-z0-9]|-)*" placeholder="prod-incidents" />
          </label>
        </div>

        <label>投递策略
          <div className="strategy-picker">
            <button type="button" className={strategy === 'fanout' ? 'active' : ''} onClick={() => setStrategy('fanout')}>
              <Network size={18} />
              <span><strong>并发广播</strong><small>同时发送到全部频道</small></span>
            </button>
            <button type="button" className={strategy === 'fallback' ? 'active' : ''} onClick={() => setStrategy('fallback')}>
              <RouteIcon size={18} />
              <span><strong>故障转移</strong><small>按顺序尝试，成功即停止</small></span>
            </button>
          </div>
        </label>

        <div>
          <div className="field-label">频道与顺序 <span>{selected.length} 个</span></div>
          <div className="route-builder">
            <div className="available-channels">
              {channels.filter((channel) => channel.enabled).map((channel) => (
                <label className="channel-choice" key={channel.id}>
                  <input type="checkbox" checked={selected.includes(channel.id)} onChange={() => toggle(channel.id)} />
                  <ProviderIcon provider={channel.provider as ProviderId} name={channel.name} size={29} />
                  <span><strong>{channel.name}</strong><small>{channel.provider}</small></span>
                </label>
              ))}
              {!channels.filter((c) => c.enabled).length && (
                <p className="builder-empty">没有可用的已启用频道</p>
              )}
            </div>
            {selected.length > 0 && (
              <div className="selected-order">
                <p>{strategy === 'fallback' ? '尝试顺序' : '投递频道'}</p>
                {selected.map((id, index) => {
                  const channel = channels.find((item) => item.id === id);
                  return (
                    <div key={id}>
                      <span className="order-index">{index + 1}</span>
                      <ProviderIcon provider={(channel?.provider ?? 'webhook') as ProviderId} name={channel?.name} size={26} />
                      <strong>{channel?.name ?? '未知频道'}</strong>
                      <span className="order-buttons">
                        <IconButton type="button" label="上移" icon={ArrowUp} disabled={index === 0} onClick={() => move(index, -1)} />
                        <IconButton type="button" label="下移" icon={ArrowDown} disabled={index === selected.length - 1} onClick={() => move(index, 1)} />
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        <footer className="modal-actions">
          <Button type="button" onClick={close}>取消</Button>
          <Button type="submit" variant="primary" icon={Check} loading={busy} disabled={!selected.length}>保存路由</Button>
        </footer>
      </form>
    </Modal>
  );
}

export function Routes({
  routes, channels, refresh, notify
}: {
  routes: Route[];
  channels: Channel[];
  refresh: () => void;
  notify: Notify;
}) {
  const [editing, setEditing] = useState<Route | null | 'new'>(null);

  const remove = async (route: Route) => {
    if (!confirm(`删除路由“${route.name}”？`)) return;
    try {
      await api.deleteRoute(route.id);
      notify('success', '路由已删除');
      refresh();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '删除失败');
    }
  };

  return (
    <>
      <header className="page-head">
        <div>
          <h1>路由</h1>
          <p className="page-sub">{routes.length} 条路由 · 一个稳定标识符可映射多个推送频道</p>
        </div>
        <Button variant="primary" icon={Plus} onClick={() => setEditing('new')} disabled={!channels.length}>新建路由</Button>
      </header>

      {routes.length ? (
        <div className="route-list">
          {routes.map((route) => (
            <section className="route-row" key={route.id}>
              <div className="route-identity"><h3>{route.name}</h3><code>{route.slug}</code></div>
              <div className="route-flow">
                <span>{route.strategy === 'fanout' ? '并发广播' : '故障转移'}</span>
                <div>
                  {route.channelIds.map((id, index) => {
                    const channel = channels.find((item) => item.id === id);
                    return (
                      <span className="route-node" key={id}>
                        <i>{index + 1}</i>
                        <ProviderIcon provider={(channel?.provider ?? 'webhook') as ProviderId} name={channel?.name} size={18} />
                        {channel?.name ?? '已删除频道'}
                      </span>
                    );
                  })}
                </div>
              </div>
              <span className={`state-dot ${route.enabled ? 'active' : ''}`}>{route.enabled ? '启用' : '停用'}</span>
              <div className="row-actions">
                <IconButton label="编辑" icon={Edit3} onClick={() => setEditing(route)} />
                <IconButton label="删除" icon={Trash2} onClick={() => remove(route)} />
              </div>
            </section>
          ))}
        </div>
      ) : (
        <section className="panel">
          <Empty
            icon={RouteIcon}
            title={channels.length ? '还没有通知路由' : '请先添加推送频道'}
            text={channels.length ? '把多个频道组合成并发广播或故障转移链。' : '路由至少需要一个已启用的频道。'}
            action={channels.length > 0 && <Button variant="primary" icon={Plus} onClick={() => setEditing('new')}>新建路由</Button>}
          />
        </section>
      )}

      {editing && (
        <RouteForm channels={channels} route={editing === 'new' ? undefined : editing} close={() => setEditing(null)} saved={refresh} notify={notify} />
      )}
    </>
  );
}
