import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { LoaderCircle, MessageCircleQuestion, RefreshCw, Send } from 'lucide-react';
import type { Conversation } from '../../shared/types';
import { api } from '../api';
import { Badge, Empty, IconButton, Notify, formatDate } from './ui';

/* ────────────────────────────────────────────────────────────
 * 会话：Agent 通过 ask_user 提出的问题，管理员在此直接回复。
 * 有待回复会话时自动轮询（Agent 正在阻塞等待，需要尽快看到）。
 * ──────────────────────────────────────────────────────────── */

const statusOf = (conversation: Conversation): 'pending' | 'replied' | 'expired' =>
  conversation.repliedAt ? 'replied' : conversation.expiresAt <= new Date().toISOString() ? 'expired' : 'pending';

const SOURCE_LABEL: Record<string, string> = { admin: '控制台', 'reply-link': '回复链接' };

export function Conversations({ notify, onChanged }: { notify: Notify; onChanged: () => void }) {
  const [items, setItems] = useState<Conversation[]>();
  const [pendingOnly, setPendingOnly] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState('');

  const load = useCallback(async (quiet = false) => {
    try {
      setItems((await api.conversations(pendingOnly)).conversations);
    } catch (error) {
      if (!quiet) notify('error', error instanceof Error ? error.message : '加载会话失败');
    }
  }, [pendingOnly, notify]);

  useEffect(() => { void load(); }, [load]);

  const hasPending = items?.some((item) => statusOf(item) === 'pending') ?? false;
  useEffect(() => {
    if (!hasPending) return;
    const timer = window.setInterval(() => void load(true), 8000);
    return () => window.clearInterval(timer);
  }, [hasPending, load]);

  const reply = async (conversation: Conversation, text: string) => {
    const trimmed = text.trim();
    if (!trimmed || busyId) return;
    setBusyId(conversation.id);
    try {
      await api.replyConversation(conversation.id, trimmed);
      notify('success', '回复已送达，Agent 将继续执行');
      setDrafts((old) => ({ ...old, [conversation.id]: '' }));
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '回复失败');
    } finally {
      setBusyId('');
      await load(true);
      onChanged();
    }
  };

  const submit = (event: FormEvent, conversation: Conversation) => {
    event.preventDefault();
    void reply(conversation, drafts[conversation.id] ?? '');
  };

  const pendingCount = items?.filter((item) => statusOf(item) === 'pending').length ?? 0;

  return (
    <>
      <header className="page-head">
        <div>
          <h1>会话</h1>
          <p className="page-sub">{pendingCount ? `${pendingCount} 个问题等待回复 · Agent 正在阻塞等待` : 'Agent 通过 ask_user 发起的提问与回复记录'}</p>
        </div>
        <IconButton label="刷新" icon={RefreshCw} onClick={() => void load()} />
      </header>

      <div className="toolbar">
        <div className="segments segments-2" role="tablist" aria-label="会话筛选">
          <button type="button" role="tab" aria-selected={!pendingOnly} className={!pendingOnly ? 'active' : ''} onClick={() => setPendingOnly(false)}>全部</button>
          <button type="button" role="tab" aria-selected={pendingOnly} className={pendingOnly ? 'active' : ''} onClick={() => setPendingOnly(true)}>待回复</button>
        </div>
      </div>

      {items === undefined ? (
        <section className="panel"><div className="modal-loading"><LoaderCircle className="spin" /></div></section>
      ) : items.length > 0 ? (
        <div className="conv-list">
          {items.map((conversation) => {
            const status = statusOf(conversation);
            return (
              <section className={`conv-card ${status === 'expired' ? 'disabled-row' : ''}`} key={conversation.id}>
                <div className="conv-head">
                  <p className="conv-q">{conversation.question}</p>
                  <Badge status={status} />
                </div>
                <div className="conv-meta">
                  <span>提问于 {formatDate(conversation.createdAt)}</span>
                  {status === 'pending' && <span>有效期至 {formatDate(conversation.expiresAt)}</span>}
                  {conversation.repliedAt && <span>回复于 {formatDate(conversation.repliedAt)} · 来自{SOURCE_LABEL[conversation.replySource ?? ''] ?? conversation.replySource}</span>}
                </div>
                {status === 'pending' && (
                  <>
                    {conversation.options && conversation.options.length > 0 && (
                      <div className="conv-options">
                        {conversation.options.map((option) => (
                          <button type="button" key={option} disabled={Boolean(busyId)} onClick={() => void reply(conversation, option)}>{option}</button>
                        ))}
                      </div>
                    )}
                    <form className="conv-reply-form" onSubmit={(event) => submit(event, conversation)}>
                      <input
                        value={drafts[conversation.id] ?? ''}
                        onChange={(event) => setDrafts((old) => ({ ...old, [conversation.id]: event.target.value }))}
                        placeholder="输入回复内容…"
                        maxLength={4000}
                        disabled={busyId === conversation.id}
                      />
                      <IconButton type="submit" label="发送回复" icon={Send} spin={busyId === conversation.id} disabled={Boolean(busyId) || !(drafts[conversation.id] ?? '').trim()} />
                    </form>
                  </>
                )}
                {conversation.reply && (
                  <div className="conv-answer">
                    {conversation.reply}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      ) : (
        <section className="panel">
          <Empty
            icon={MessageCircleQuestion}
            title={pendingOnly ? '没有待回复的会话' : '还没有会话'}
            text={pendingOnly ? 'Agent 提出新问题后会显示在这里，并自动刷新。' : 'Agent 调用 ask_user 工具提问后，可以在这里直接回复，无需打开推送里的链接。'}
          />
        </section>
      )}
    </>
  );
}
