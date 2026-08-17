import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ArrowRight, KeyRound, MessageSquareText, Radio, RefreshCw, Send } from 'lucide-react';
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

  // 只在「已启用」的目的地里挑默认值；当前选中的目的地被删/禁用后重置，避免 select 显示空白
  const enabledDestinations = useMemo(() => destinations.filter((d) => d.enabled), [destinations]);
  useEffect(() => {
    if (!form.destination && enabledDestinations[0]) {
      setForm((old) => ({ ...old, destination: enabledDestinations[0].id }));
    } else if (form.destination && !enabledDestinations.some((d) => d.id === form.destination)) {
      setForm((old) => ({ ...old, destination: enabledDestinations[0]?.id ?? '' }));
    }
  }, [enabledDestinations, form.destination]);

  const hasChannels = (stats?.channels ?? 0) > 0;
  const hasKeys = (stats?.activeKeys ?? 0) > 0;
  const needsOnboarding = !hasChannels || !hasKeys;

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
    { label: '启用频道', value: `${stats?.enabledChannels ?? 0} / ${stats?.channels ?? 0}` },
    { label: '近 24h 投递', value: stats?.deliveries24h ?? 0 },
    // 无投递时显示占位符而非误导性的 100%
    { label: '送达率', value: !stats?.deliveries24h ? '—' : `${stats.successRate24h}%` },
    { label: '失败', value: stats?.failed24h ?? 0, danger: (stats?.failed24h ?? 0) > 0 }
  ];

  return (
    <>
      <header className="page-head">
        <h1>概览</h1>
        <IconButton label="刷新数据" icon={RefreshCw} onClick={refresh} />
      </header>

      {needsOnboarding && (
        <section className="onboarding-banner">
          <div className="onboarding-head">
            <Radio size={18} />
            <h2>快速开始</h2>
          </div>
          <div className="onboarding-steps">
            <a className={`onboarding-step ${hasChannels ? 'done' : 'todo'}`} href="#channels">
              <span className="step-num">{hasChannels ? '✓' : '1'}</span>
              <MessageSquareText size={18} />
              <div>
                <strong>添加推送频道</strong>
                <span>选择 Telegram、企业微信、飞书等通知渠道</span>
              </div>
              {!hasChannels && <ArrowRight size={15} className="step-arrow" />}
            </a>
            <a className={`onboarding-step ${hasKeys ? 'done' : 'todo'}`} href="#keys">
              <span className="step-num">{hasKeys ? '✓' : '2'}</span>
              <KeyRound size={18} />
              <div>
                <strong>创建 Agent API Key</strong>
                <span>Agent 用它通过 MCP 或 REST 发送通知</span>
              </div>
              {!hasKeys && <ArrowRight size={15} className="step-arrow" />}
            </a>
            <a className="onboarding-step todo" href="#integrations">
              <span className="step-num">3</span>
              <Send size={18} />
              <div>
                <strong>接入 Agent</strong>
                <span>复制 MCP 配置，填入 Agent 客户端</span>
              </div>
              <ArrowRight size={15} className="step-arrow" />
            </a>
          </div>
        </section>
      )}

      <div className="page-grid overview-grid">
        <section className="stats-strip">
          {statItems.map(({ label, value, danger }) => (
            <div className="stat" key={label}>
              <p>{label}</p>
              <strong className={danger ? 'danger' : ''}>{value}</strong>
            </div>
          ))}
        </section>

        <section className="panel recent-panel">
          <div className="section-head">
            <h2>最近投递</h2>
            <IconButton label="刷新" icon={RefreshCw} onClick={refresh} />
          </div>
          {deliveries.length ? (
            <div className="table-wrap">
              <table className="responsive-table">
                <thead>
                  <tr><th>消息</th><th>目的地</th><th>来源</th><th>状态</th><th>时间</th></tr>
                </thead>
                <tbody>
                  {deliveries.slice(0, 8).map((item) => (
                    <tr key={item.id}>
                      <td data-label="消息">
                        <strong className="table-title">{item.title}</strong>
                        <span className="muted-row">{item.id.slice(0, 8)}</span>
                      </td>
                      <td data-label="目的地">{item.targetName ?? item.targetId.slice(0, 8)}</td>
                      <td data-label="来源">{item.source === 'admin' ? '控制台' : 'Agent'}</td>
                      <td data-label="状态"><Badge status={item.status} /></td>
                      <td data-label="时间" className="nowrap">{formatDate(item.createdAt)}</td>
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
          <div className="section-head"><h2>快速发送</h2></div>
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
    </>
  );
}
