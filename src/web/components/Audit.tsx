import { useCallback, useEffect, useState } from 'react';
import { LoaderCircle, RefreshCw, ScrollText, Search } from 'lucide-react';
import type { AuditEvent } from '../../shared/types';
import { api } from '../api';
import { Empty, IconButton, Notify, formatDate } from './ui';

/* ────────────────────────────────────────────────────────────
 * 审计日志：管理员与 Agent 的全部变更操作记录。
 * 支持按操作者（admin / agent: 前缀）与动作（channel. / key. 等）过滤。
 * ──────────────────────────────────────────────────────────── */

const actorLabel = (actor: string): string => actor === 'admin' ? '管理员' : actor.startsWith('agent:') ? `Agent ${actor.slice(6, 14)}…` : actor;

const actionLabel = (action: string): string => {
  const [resource, verb] = action.split('.');
  const RESOURCES: Record<string, string> = { channel: '频道', route: '路由', key: '密钥', credential: '凭据', conversation: '会话' };
  const VERBS: Record<string, string> = { create: '创建', update: '更新', delete: '删除', disable: '停用', revoke: '吊销', restore: '恢复', reply: '回复', rotate: '轮换' };
  return `${RESOURCES[resource] ?? resource} ${VERBS[verb] ?? verb}`;
};

export function Audit({ notify }: { notify: Notify }) {
  const [items, setItems] = useState<AuditEvent[]>();
  const [actor, setActor] = useState('');
  const [action, setAction] = useState('');

  const load = useCallback(async (quiet = false) => {
    try {
      setItems((await api.auditEvents({ actor: actor || undefined, action: action || undefined, limit: 200 })).events);
    } catch (error) {
      if (!quiet) notify('error', error instanceof Error ? error.message : '加载审计日志失败');
    }
  }, [actor, action, notify]);

  useEffect(() => { void load(); }, [load]);

  return (
    <>
      <header className="page-head">
        <div>
          <h1>审计</h1>
          <p className="page-sub">频道、密钥、凭据等全部变更操作记录（最新 200 条）</p>
        </div>
        <IconButton label="刷新" icon={RefreshCw} onClick={() => void load()} />
      </header>

      <div className="toolbar">
        <div className="filters">
          <div className="search">
            <Search size={15} />
            <input placeholder="操作者：admin 或 agent:" value={actor} onChange={(event) => setActor(event.target.value)} />
          </div>
          <select value={action} onChange={(event) => setAction(event.target.value)} aria-label="动作筛选">
            <option value="">全部动作</option>
            <option value="channel.">频道变更</option>
            <option value="route.">路由变更</option>
            <option value="key.">密钥变更</option>
            <option value="credential.">凭据轮换</option>
            <option value="conversation.">会话回复</option>
          </select>
        </div>
      </div>

      <section className="panel">
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>时间</th><th>操作者</th><th>动作</th><th>对象</th><th>详情</th></tr>
            </thead>
            <tbody>
              {items?.map((event) => (
                <tr key={event.id}>
                  <td>{formatDate(event.createdAt)}</td>
                  <td>{actorLabel(event.actor)}</td>
                  <td>{actionLabel(event.action)}</td>
                  <td><code>{event.resourceId ? event.resourceId.slice(0, 8) : '—'}</code></td>
                  <td className="audit-details">{Object.keys(event.details).length ? JSON.stringify(event.details) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {items && !items.length && (
            <Empty icon={ScrollText} title="暂无审计记录" text="符合当前筛选条件的变更操作会显示在这里。" />
          )}
          {!items && <div className="modal-loading"><LoaderCircle className="spin" /></div>}
        </div>
      </section>
    </>
  );
}
