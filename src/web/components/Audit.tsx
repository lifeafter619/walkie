import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bot, KeyRound, LoaderCircle, MessageSquareReply, RefreshCw, Route, ScrollText, Search, Settings, ShieldCheck, Trash2, UserRound } from 'lucide-react';
import type { AuditEvent, ProviderId } from '../../shared/types';
import { api } from '../api';
import { Button, Empty, IconButton, Modal, type Notify, formatDate } from './ui';
import { ProviderIcon } from './ProviderIcon';

const ACTION_LABELS: Record<string, string> = {
  'channel.create': '创建频道', 'channel.update': '更新频道', 'channel.disable': '停用频道', 'channel.delete': '删除频道',
  'route.create': '创建路由', 'route.update': '更新路由', 'route.disable': '停用路由', 'route.delete': '删除路由',
  'api_key.create': '创建 Agent Key', 'api_key.update': '更新 Agent Key', 'api_key.revoke': '吊销 Agent Key', 'api_key.restore': '恢复 Agent Key', 'api_key.delete': '删除 Agent Key',
  'credential.admin_token.create': '创建管理密码', 'credential.admin_token.revoke': '撤销管理密码', 'credential.admin_token.restore': '恢复管理密码',
  'credential.master_key.rotate': '轮换数据加密密钥', 'credential.platform_usage.token.update': '更新平台 Token',
  'conversation.reply': '回复会话', 'retention.update': '更新保留策略', 'usage_limits.update': '更新用量限制',
  'platform_usage.update': '更新平台监控', 'platform_usage.token.update': '更新平台 Token', 'delivery.disable': '暂停全部推送', 'delivery.enable': '恢复全部推送', 'audit.clear': '清空审计日志'
};

const DETAIL_LABELS: Record<string, string> = {
  provider: '渠道', strategy: '策略', name: '名称', prefix: '前缀', fields: '字段', reason: '原因', version: '版本',
  deleted: '已清空', enabled: '启用', action: '动作', warningPercent: '告警阈值'
};

const actorLabel = (actor: string): string => actor === 'admin'
  ? '管理员'
  : actor.startsWith('agent:') ? `Agent ${actor.slice(6, 14)}...`
    : actor.startsWith('system:') ? `系统 ${actor.slice(7)}` : actor;

const detailValue = (value: unknown) => typeof value === 'boolean'
  ? value ? '是' : '否'
  : typeof value === 'string' || typeof value === 'number' ? String(value)
    : JSON.stringify(value);

function AuditIcon({ event }: { event: AuditEvent }) {
  const provider = event.details.provider;
  if (event.resourceType === 'channel' && typeof provider === 'string') return <ProviderIcon provider={provider as ProviderId} name={provider} size={30} />;
  if (event.resourceType === 'route') return <Route size={17} />;
  if (event.resourceType === 'api_key') return <Bot size={17} />;
  if (event.resourceType === 'credential') return <KeyRound size={17} />;
  if (event.resourceType === 'conversation') return <MessageSquareReply size={17} />;
  if (event.resourceType === 'audit') return <ScrollText size={17} />;
  return <Settings size={17} />;
}

export function Audit({ notify }: { notify: Notify }) {
  const [items, setItems] = useState<AuditEvent[]>();
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');
  const [query, setQuery] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  const load = useCallback(async (quiet = false) => {
    try { setItems((await api.auditEvents({ actor: actor || undefined, action: action || undefined, limit: 200 })).events); }
    catch (error) { if (!quiet) notify('error', error instanceof Error ? error.message : '加载审计日志失败'); }
  }, [actor, action, notify]);

  useEffect(() => { void load(); }, [load]);

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return items;
    return items?.filter((event) => `${actorLabel(event.actor)} ${ACTION_LABELS[event.action] ?? event.action} ${event.resourceType} ${event.resourceId ?? ''} ${JSON.stringify(event.details)}`.toLowerCase().includes(keyword));
  }, [items, query]);

  const clear = async () => {
    setClearing(true);
    try {
      const result = await api.clearAudit();
      setConfirmClear(false);
      await load();
      notify('success', `已清空 ${result.deleted} 条审计记录`);
    } catch (error) { notify('error', error instanceof Error ? error.message : '清空失败'); }
    finally { setClearing(false); }
  };

  return (
    <>
      <header className="page-head">
        <div><h1>审计</h1><p className="page-sub">查看谁在什么时间更改了实例配置</p></div>
        <div className="page-actions"><IconButton label="刷新" icon={RefreshCw} onClick={() => void load()} /><Button variant="danger" icon={Trash2} onClick={() => setConfirmClear(true)}>清空日志</Button></div>
      </header>

      <div className="toolbar audit-toolbar">
        <div className="search"><Search size={15} /><input placeholder="搜索动作、对象或详情" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
        <select value={actor} onChange={(event) => setActor(event.target.value)} aria-label="操作者筛选">
          <option value="">全部操作者</option><option value="admin">管理员</option><option value="agent:">Agent</option><option value="system:">系统</option>
        </select>
        <select value={action} onChange={(event) => setAction(event.target.value)} aria-label="动作筛选">
          <option value="">全部动作</option><option value="channel.">频道</option><option value="route.">路由</option><option value="api_key.">Agent Key</option>
          <option value="credential.">凭据</option><option value="conversation.">会话</option><option value="platform_usage.">平台监控</option><option value="retention.">保留策略</option><option value="audit.">审计</option>
        </select>
        <span className="audit-count">{visible ? `${visible.length} 条` : '加载中…'}</span>
      </div>

      <section className="panel audit-stream">
        {visible?.map((event) => (
          <article className="audit-event" key={event.id}>
            <div className={`audit-event-icon ${event.action.includes('delete') || event.action.includes('revoke') || event.action === 'audit.clear' ? 'danger' : ''}`}><AuditIcon event={event} /></div>
            <div className="audit-event-main">
              <div className="audit-event-title"><strong>{ACTION_LABELS[event.action] ?? event.action}</strong><span>{formatDate(event.createdAt)}</span></div>
              <div className="audit-event-meta">
                <span>{event.actor === 'admin' ? <UserRound size={13} /> : event.actor.startsWith('agent:') ? <Bot size={13} /> : <ShieldCheck size={13} />}{actorLabel(event.actor)}</span>
                <code>{event.resourceType}{event.resourceId ? ` · ${event.resourceId.slice(0, 8)}` : ''}</code>
              </div>
              {Object.keys(event.details).length > 0 && <dl className="audit-detail-list">{Object.entries(event.details).map(([key, value]) => <div key={key}><dt>{DETAIL_LABELS[key] ?? key}</dt><dd>{detailValue(value)}</dd></div>)}</dl>}
            </div>
          </article>
        ))}
        {visible && !visible.length && <Empty icon={ScrollText} title="没有匹配的审计记录" text="调整筛选条件后再查看。" />}
        {!visible && <div className="modal-loading"><LoaderCircle className="spin" /></div>}
      </section>

      {confirmClear && <Modal title="确认清空审计日志" onClose={() => setConfirmClear(false)}>
        <div className="modal-body"><p>将删除当前全部审计记录。系统会保留一条本次清空操作，便于追溯。</p><footer className="modal-actions"><Button onClick={() => setConfirmClear(false)}>取消</Button><Button variant="danger" icon={Trash2} loading={clearing} onClick={clear}>确认清空</Button></footer></div>
      </Modal>}
    </>
  );
}
