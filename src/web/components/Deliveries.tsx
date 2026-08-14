import { useEffect, useState } from 'react';
import { Activity, ChevronRight, ExternalLink, LoaderCircle, RefreshCw, Search } from 'lucide-react';
import type { Delivery, ProviderId } from '../../shared/types';
import { api } from '../api';
import { Badge, Empty, IconButton, Modal, Notify, SEVERITY_LABEL, formatDate } from './ui';
import { ProviderIcon } from './ProviderIcon';

/* ────────────────────────────────────────────────────────────
 * 投递记录：列表 + 详情。每次渠道尝试展示真实渠道图标。
 * ──────────────────────────────────────────────────────────── */

export function DeliveryDetail({ id, close, notify }: { id: string; close: () => void; notify: Notify }) {
  const [delivery, setDelivery] = useState<Delivery>();

  useEffect(() => {
    setDelivery(undefined);
    api.delivery(id).then(setDelivery).catch((error: Error) => notify('error', error.message));
  }, [id, notify]);

  return (
    <Modal title="投递详情" onClose={close} wide>
      {!delivery ? (
        <div className="modal-loading"><LoaderCircle className="spin" /></div>
      ) : (
        <div className="modal-body delivery-detail">
          <div className="delivery-head">
            <div>
              <Badge status={delivery.status} />
              <h3>{delivery.title}</h3>
              <p>{delivery.body}</p>
              {delivery.url && (
                <a href={delivery.url} target="_blank" rel="noreferrer">{delivery.url}<ExternalLink size={14} /></a>
              )}
            </div>
            <dl>
              <div><dt>投递 ID</dt><dd><code>{delivery.id}</code></dd></div>
              <div><dt>目的地</dt><dd>{delivery.targetName ?? delivery.targetId}</dd></div>
              <div><dt>来源</dt><dd>{delivery.source}</dd></div>
              <div><dt>创建时间</dt><dd>{formatDate(delivery.createdAt)}</dd></div>
            </dl>
          </div>
          <div className="attempts">
            <h4>渠道尝试</h4>
            {delivery.attempts?.map((attempt) => (
              <div className="attempt" key={attempt.id}>
                <span className="attempt-line" />
                <ProviderIcon provider={(attempt.provider ?? 'webhook') as ProviderId} name={attempt.channelName} size={28} />
                <div>
                  <strong>{attempt.channelName ?? '未知频道'}</strong>
                  <p>{attempt.provider} · 第 {attempt.attemptCount} 次尝试</p>
                  {attempt.error && <small className="error-text">{attempt.error}</small>}
                </div>
                <Badge status={attempt.status} />
                <time>{formatDate(attempt.updatedAt)}</time>
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

export function Deliveries({
  deliveries, refresh, notify
}: {
  deliveries: Delivery[];
  refresh: (status?: string) => void;
  notify: Notify;
}) {
  const [status, setStatus] = useState('');
  const [selected, setSelected] = useState('');
  const [query, setQuery] = useState('');

  const filtered = deliveries.filter((item) =>
    `${item.title} ${item.targetName} ${item.id}`.toLowerCase().includes(query.toLowerCase())
  );
  const changeStatus = (next: string) => { setStatus(next); refresh(next); };

  return (
    <>
      <header className="page-head">
        <h1>投递</h1>
        <IconButton label="刷新" icon={RefreshCw} onClick={() => refresh(status)} />
      </header>

      <div className="toolbar">
        <div className="filters">
          <div className="search">
            <Search size={15} />
            <input placeholder="搜索标题或 ID" value={query} onChange={(event) => setQuery(event.target.value)} />
          </div>
          <select value={status} onChange={(event) => changeStatus(event.target.value)} aria-label="投递状态">
            <option value="">全部状态</option>
            <option value="queued">排队中</option>
            <option value="processing">发送中</option>
            <option value="delivered">已送达</option>
            <option value="partial">部分送达</option>
            <option value="failed">失败</option>
          </select>
        </div>
      </div>

      <section className="panel">
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>通知</th><th>目的地</th><th>级别</th><th>来源</th><th>状态</th><th>创建时间</th><th /></tr>
            </thead>
            <tbody>
              {filtered.map((item) => (
                <tr className="clickable-row" key={item.id} onClick={() => setSelected(item.id)}>
                  <td>
                    <strong className="table-title">{item.title}</strong>
                    <code>{item.id.slice(0, 12)}</code>
                  </td>
                  <td>{item.targetName ?? item.targetId.slice(0, 8)}</td>
                  <td><span className={`severity severity-${item.severity}`}>{SEVERITY_LABEL[item.severity]}</span></td>
                  <td>{item.source === 'admin' ? '控制台' : 'Agent'}</td>
                  <td><Badge status={item.status} /></td>
                  <td>{formatDate(item.createdAt)}</td>
                  <td><ChevronRight size={16} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!filtered.length && (
            <Empty icon={Activity} title="暂无投递记录" text="符合当前筛选条件的投递会显示在这里。" />
          )}
        </div>
      </section>

      {selected && <DeliveryDetail id={selected} close={() => setSelected('')} notify={notify} />}
    </>
  );
}
