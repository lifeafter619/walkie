import { useEffect, useState, type FormEvent } from 'react';
import { Activity, AlertTriangle, Gauge, MessageSquareText, RefreshCw, Send } from 'lucide-react';
import type { DashboardStats, Delivery, Destination, Severity } from '../../shared/types';
import { api } from '../api';
import { Badge, Button, Empty, IconButton, Notify, SEVERITY_LABEL, formatDate } from './ui';

export function Overview({
  stats, deliveries, destinations, refresh, notify
}: {
  stats?: DashboardStats;
  deliveries: Delivery[];
  destinations: Destination[];
  refresh: () => void;
  notify: Notify;
}) {
  const [form, setForm] = useState({ destination: '', title: '', body: '', severity: 'info' as Severity });
  const [busy, setBusy] = useState(false);

  // Bug 修复：只在「已启用」的目的地里挑默认值，且避免重复赋值
  const enabledDestinations = destinations.filter((d) => d.enabled);
  useEffect(() => {
    if (!form.destination && enabledDestinations[0]) {
      setForm((old) => ({ ...old, destination: enabledDestinations[0].id }));
    }
  }, [enabledDestinations, form.destination]);

  const send = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const delivery = await api.send(form);
      notify('success', `通知已进入队列 · ${delivery.id.slice(0, 8)}`);
      setForm((old) => ({ ...old, title: '', body: '' }));
      refresh();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '发送失败');
    } finally {
      setBusy(false);
    }
  };

  const statItems = [
    { label: '启用频道', value: `${stats?.enabledChannels ?? 0} / ${stats?.channels ?? 0}`, icon: MessageSquareText, tone: 'green' },
    { label: '近 24h 投递', value: stats?.deliveries24h ?? 0, icon: Send, tone: 'blue' },
    { label: '送达率', value: `${stats?.successRate24h ?? 100}%`, icon: Gauge, tone: 'amber' },
    { label: '失败', value: stats?.failed24h ?? 0, icon: AlertTriangle, tone: (stats?.failed24h ?? 0) > 0 ? 'red' : 'neutral' }
  ];

  return (
    <div className="page-grid overview-grid">
      <section className="stats-strip">
        {statItems.map(({ label, value, icon: Icon, tone }) => (
          <div className="stat" key={label}>
            <span className={`stat-icon tone-${tone}`}><Icon size={18} /></span>
            <div>
              <p>{label}</p>
              <strong>{value}</strong>
            </div>
          </div>
        ))}
      </section>

      <section className="panel recent-panel">
        <div className="section-head">
          <div><h2>最近投递</h2><p>最新 8 条通知</p></div>
          <IconButton label="刷新" icon={RefreshCw} onClick={refresh} />
        </div>
        {deliveries.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>消息</th><th>目的地</th><th>来源</th><th>状态</th><th>时间</th></tr>
              </thead>
              <tbody>
                {deliveries.slice(0, 8).map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong className="table-title">{item.title}</strong>
                      <span className="muted-row">{item.id.slice(0, 8)}</span>
                    </td>
                    <td>{item.targetName ?? item.targetId.slice(0, 8)}</td>
                    <td><code>{item.source === 'admin' ? '控制台' : 'Agent'}</code></td>
                    <td><Badge status={item.status} /></td>
                    <td className="nowrap">{formatDate(item.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty icon={Send} title="暂无投递" text="发送第一条通知后，状态会显示在这里。" />
        )}
      </section>

      <section className="panel quick-send">
        <div className="section-head">
          <div><h2>快速发送</h2><p>从控制台验证完整链路</p></div>
          <Send size={18} />
        </div>
        <form onSubmit={send} className="stack-form">
          <label>
            目的地
            <select value={form.destination} onChange={(event) => setForm({ ...form, destination: event.target.value })} required>
              <option value="">选择频道或路由</option>
              {enabledDestinations.map((item) => (
                <option key={item.id} value={item.id}>{item.name} · {item.kind === 'route' ? '路由' : item.provider}</option>
              ))}
            </select>
          </label>
          <label>
            级别
            <div className="segments">
              {(['info', 'success', 'warning', 'critical'] as Severity[]).map((level) => (
                <button type="button" key={level} className={form.severity === level ? 'active' : ''} onClick={() => setForm({ ...form, severity: level })}>
                  {SEVERITY_LABEL[level]}
                </button>
              ))}
            </div>
          </label>
          <label>标题
            <input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} required maxLength={200} placeholder="部署已完成" />
          </label>
          <label>内容
            <textarea rows={5} value={form.body} onChange={(event) => setForm({ ...form, body: event.target.value })} required placeholder="生产环境 v2.4.0 已成功发布。" />
          </label>
          <Button type="submit" variant="primary" icon={Send} loading={busy} disabled={!enabledDestinations.length}>
            发送通知
          </Button>
        </form>
      </section>
    </div>
  );
}

