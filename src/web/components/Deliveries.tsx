import { useEffect, useRef, useState } from 'react';
import { Activity, ChevronRight, ExternalLink, LoaderCircle, RefreshCw, Search } from 'lucide-react';
import type { Delivery, ProviderId } from '../../shared/types';
import { api } from '../api';
import { Badge, Button, Empty, IconButton, Modal, Notify, SEVERITY_LABEL, formatDate } from './ui';
import { ProviderIcon } from './ProviderIcon';

/* ────────────────────────────────────────────────────────────
 * 投递记录：列表 + 详情。每次渠道尝试展示真实渠道图标。
 * ──────────────────────────────────────────────────────────── */

export function DeliveryDetail({ id, close, notify }: { id: string; close: () => void; notify: Notify }) {
  const [delivery, setDelivery] = useState<Delivery>();
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const latestRef = useRef(0);

  useEffect(() => {
    setDelivery(undefined);
    setFailed(false);
    // 自增守卫：快速连续点开多条投递时，只有最新一次请求的结果能落地
    const current = ++latestRef.current;
    api.delivery(id).then((data) => { if (latestRef.current === current) setDelivery(data); })
      .catch((error: Error) => { if (latestRef.current === current) { setFailed(true); notify('error', error.message); } });
  }, [id, notify, reload]);

  return (
    <Modal title="投递详情" onClose={close} wide>
      {failed ? (
        <div className="modal-body">
          <Empty icon={Activity} title="加载投递详情失败" text="该投递可能已被清理，或网络暂时不可用。" action={<Button onClick={() => setReload(reload + 1)}>重试</Button>} />
        </div>
      ) : !delivery ? (
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
  deliveries, refresh, notify, filterStatus: status, onFilterChange, onSearchChange
}: {
  deliveries: Delivery[];
  refresh: (status?: string, q?: string, before?: string, quiet?: boolean, append?: boolean) => Promise<void>;
  notify: Notify;
  /** 筛选状态由 App 持有：30s 全量轮询要沿用当前筛选，否则无筛选数据会覆盖列表 */
  filterStatus: string;
  onFilterChange: (status: string) => void;
  /** 服务端搜索词提交回调（App 存 ref 供轮询沿用） */
  onSearchChange: (q: string) => void;
}) {
  const [selected, setSelected] = useState('');
  const [query, setQuery] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);

  // 服务端搜索：300ms 防抖提交（q 透传到 SQL LIKE，不再局限于已加载的 100 条）
  useEffect(() => {
    const timer = window.setTimeout(() => {
      onSearchChange(query);
      void refresh(status, query);
    }, 300);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const changeStatus = (next: string) => { onFilterChange(next); void refresh(next, query); };

  // 有未终结投递时每 5 秒静默刷新（仅第一页），全部到终态后自动停止；后台标签暂停
  const hasActive = deliveries.some((item) => item.status === 'queued' || item.status === 'processing');
  useEffect(() => {
    if (!hasActive) return;
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(status, query, '', true); }, 5000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasActive, status, query]);

  const loadMore = async () => {
    if (loadingMore || deliveries.length < 50) return;
    setLoadingMore(true);
    try {
      // 以当前最旧一条的 createdAt + id 复合游标取更早的一页，避免同毫秒记录丢失
      const oldest = deliveries[deliveries.length - 1];
      await refresh(status, query, `${oldest.createdAt}|${oldest.id}`, false, true);
    } finally {
      setLoadingMore(false);
    }
  };

  return (
    <>
      <header className="page-head">
        <h1>投递</h1>
        <IconButton label="刷新" icon={RefreshCw} onClick={() => refresh(status, query)} />
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
          <table className="responsive-table">
            <thead>
              <tr><th>通知</th><th>目的地</th><th>级别</th><th>来源</th><th>状态</th><th>创建时间</th><th /></tr>
            </thead>
            <tbody>
              {deliveries.map((item) => (
                <tr className="clickable-row" key={item.id} onClick={() => setSelected(item.id)}>
                  <td data-label="通知">
                    <strong className="table-title">{item.title}</strong>
                    <code>{item.id.slice(0, 12)}</code>
                  </td>
                  <td data-label="目的地">{item.targetName ?? item.targetId.slice(0, 8)}</td>
                  <td data-label="级别"><span className={`severity severity-${item.severity}`}>{SEVERITY_LABEL[item.severity]}</span></td>
                  <td data-label="来源">{item.source === 'admin' ? '控制台' : 'Agent'}</td>
                  <td data-label="状态"><Badge status={item.status} /></td>
                  <td data-label="创建时间">{formatDate(item.createdAt)}</td>
                  <td className="card-chevron"><ChevronRight size={16} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {!deliveries.length ? (
            <Empty icon={Activity} title="暂无投递记录" text="符合当前筛选条件的投递会显示在这里。" />
          ) : (
            <div className="list-footer">
              {/* 服务端按时间倒序取页；页满说明可能还有更早的记录 */}
              {deliveries.length >= 50 && (
                <Button onClick={loadMore} loading={loadingMore} disabled={loadingMore}>加载更早的投递</Button>
              )}
              {deliveries.length < 50 && <span className="muted" style={{ fontSize: 12 }}>已到最早记录</span>}
            </div>
          )}
        </div>
      </section>

      {selected && <DeliveryDetail id={selected} close={() => setSelected('')} notify={notify} />}
    </>
  );
}
