import { useEffect, useState, type FormEvent } from 'react';
import {
  Check, Edit3, ExternalLink, KeyRound, LoaderCircle, MessageSquareText,
  Plus, Search, TestTube2, Trash2
} from 'lucide-react';
import type { Channel, ProviderDefinition, ProviderId } from '../../shared/types';
import { api } from '../api';
import { Badge, Button, Empty, IconButton, Modal, Notify, slugify } from './ui';
import { ProviderIcon } from './ProviderIcon';
import { ChannelPicker, ProviderSelect } from './ChannelPicker';

/* ────────────────────────────────────────────────────────────
 * SMTP 邮箱服务商预设：选择后自动填充 host/port/secure 并锁定。
 * preset 仅前端 UX 层，发信时 sendSmtp 直接读 host/port/secure。
 * ──────────────────────────────────────────────────────────── */
const SMTP_PRESETS: Record<string, { host: string; port: number; secure: boolean }> = {
  'tencent-exmail': { host: 'smtp.exmail.qq.com', port: 465, secure: true },
  'netease-qiye': { host: 'smtp.qiye.163.com', port: 465, secure: true },
  qq: { host: 'smtp.qq.com', port: 465, secure: true },
  '163': { host: 'smtp.163.com', port: 465, secure: true },
  gmail: { host: 'smtp.gmail.com', port: 465, secure: true },
  outlook: { host: 'smtp-mail.outlook.com', port: 587, secure: false },
  'aliyun-mail': { host: 'smtp.qiye.aliyun.com', port: 465, secure: true }
};

const SMTP_LOCKED_KEYS = new Set(['host', 'port', 'secure']);

/* ────────────────────────────────────────────────────────────
 * 频道管理：列表 + 表单。
 * 渠道类型选择改为图标弹框（ChannelPicker），表单内用 ProviderSelect 触发。
 * ──────────────────────────────────────────────────────────── */

export function ChannelForm({
  providers, channel, close, saved, notify
}: {
  providers: ProviderDefinition[];
  channel?: Channel;
  close: () => void;
  saved: () => void;
  notify: Notify;
}) {
  const [name, setName] = useState(channel?.name ?? '');
  const [channelSlug, setSlug] = useState(channel?.slug ?? '');
  const [provider, setProvider] = useState<ProviderId>(channel?.provider ?? providers[0]?.id ?? 'telegram');
  const [config, setConfig] = useState<Record<string, unknown>>({});
  const [rateLimit, setRateLimit] = useState(channel?.rateLimitPerMin ?? 0);
  const [quiet, setQuiet] = useState(channel?.quietHours ?? '');
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);

  const definition = providers.find((item) => item.id === provider);

  // 切换渠道时重置该渠道的默认值（依赖修正：只在 provider 变化时执行）
  useEffect(() => {
    if (channel) return; // 编辑模式不覆盖已有配置
    setConfig(Object.fromEntries(
      (definition?.fields ?? []).filter((item) => item.defaultValue !== undefined).map((item) => [item.key, item.defaultValue])
    ));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const body = { name, slug: channelSlug || slugify(name), provider, config, rateLimitPerMin: rateLimit || null, quietHours: quiet || null };
      channel ? await api.updateChannel(channel.id, body) : await api.createChannel(body);
      notify('success', channel ? '频道已更新' : '频道已创建');
      saved();
      close();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={channel ? '编辑频道' : '添加推送频道'} onClose={close} wide>
      <form onSubmit={submit} className="modal-body">
        <div className="form-grid">
          <label>名称
            <input autoFocus value={name} onChange={(event) => { setName(event.target.value); if (!channel) setSlug(slugify(event.target.value)); }} required placeholder="生产告警群" />
          </label>
          <label>标识符
            <input value={channelSlug} onChange={(event) => setSlug(event.target.value)} required pattern="[a-z0-9](?:[a-z0-9]|-)*" placeholder="prod-alerts" />
          </label>
        </div>

        <label>渠道类型</label>
        <ProviderSelect
          providers={providers}
          value={provider}
          onPick={() => setPicking(true)}
          disabled={Boolean(channel)}
        />
        {picking && (
          <ChannelPicker
            providers={providers}
            current={provider}
            onPick={(next) => { setProvider(next); setConfig({}); setPicking(false); }}
            onClose={() => setPicking(false)}
            disabled={Boolean(channel)}
          />
        )}

        {definition && (
          <div className="provider-note">
            <ProviderIcon provider={definition.id} name={definition.name} size={20} />
            <div>
              <strong>{definition.name}</strong>
              <p>{definition.description}</p>
            </div>
            <a href={definition.docsUrl} target="_blank" rel="noreferrer" title="打开官方文档"><ExternalLink size={15} /></a>
          </div>
        )}

        <div className="config-fields">
          {definition?.fields.map((item) => {
            const isSmtpPreset = provider === 'smtp' && item.key === 'preset';
            const lockedByPreset = provider === 'smtp' && SMTP_LOCKED_KEYS.has(item.key) && Boolean(config.preset) && config.preset !== 'custom';
            const applyPreset = (value: string) => {
              const preset = SMTP_PRESETS[value];
              setConfig(preset ? { ...config, preset: value, host: preset.host, port: preset.port, secure: preset.secure } : { ...config, preset: value });
            };
            return (
            <label key={item.key}>
              {item.label}
              {!item.required && <span className="optional">可选</span>}
              {item.type === 'textarea' ? (
                <textarea
                  rows={item.key === 'bodyTemplate' ? 7 : 3}
                  value={String(config[item.key] ?? '')}
                  onChange={(event) => setConfig({ ...config, [item.key]: event.target.value })}
                  required={item.required && !channel}
                  placeholder={channel ? '留空保留现有值' : item.placeholder}
                />
              ) : item.type === 'select' ? (
                <select value={String(config[item.key] ?? item.defaultValue ?? '')} onChange={(event) => isSmtpPreset ? applyPreset(event.target.value) : setConfig({ ...config, [item.key]: event.target.value })}>
                  {item.options?.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              ) : item.type === 'boolean' ? (
                <span className="check-row">
                  <input type="checkbox" checked={Boolean(config[item.key] ?? item.defaultValue)} onChange={(event) => setConfig({ ...config, [item.key]: event.target.checked })} disabled={Boolean(lockedByPreset)} />
                  启用
                </span>
              ) : (
                <input
                  autoComplete={item.type === 'password' ? 'new-password' : undefined}
                  type={item.type === 'number' ? 'number' : item.type === 'password' ? 'password' : item.type === 'url' ? 'url' : 'text'}
                  value={String(config[item.key] ?? item.defaultValue ?? '')}
                  onChange={(event) => setConfig({ ...config, [item.key]: item.type === 'number' ? Number(event.target.value) : event.target.value })}
                  required={item.required && !channel}
                  placeholder={channel ? '留空保留现有值' : item.placeholder}
                  disabled={Boolean(lockedByPreset)}
                  readOnly={Boolean(lockedByPreset)}
                />
              )}
              {item.help && <small>{item.help}</small>}
              {lockedByPreset && <small>由所选邮箱服务预设自动填充，切换「自定义」可手动修改</small>}
            </label>
            );
          })}
        </div>

        <div className="form-grid">
          <label>每分钟限流<span className="optional">0 为不限</span>
            <input type="number" min={0} max={600} value={rateLimit} onChange={(event) => setRateLimit(Number(event.target.value))} />
          </label>
          <label>静默时段<span className="optional">可选</span>
            <input value={quiet} onChange={(event) => setQuiet(event.target.value)} pattern="\d{2}:\d{2}-\d{2}:\d{2}(@[\w/+-]+)?" placeholder="22:00-08:00@Asia/Shanghai" />
            <small>静默期内消息延后发送，critical 级别照常送达；不带 @时区 时按服务器本地时间（Cloudflare Workers 为 UTC）</small>
          </label>
        </div>

        <footer className="modal-actions">
          <Button type="button" onClick={close}>取消</Button>
          <Button type="submit" variant="primary" loading={busy} icon={Check}>保存频道</Button>
        </footer>
      </form>
    </Modal>
  );
}

export function Channels({
  channels, providers, refresh, notify
}: {
  channels: Channel[];
  providers: ProviderDefinition[];
  refresh: () => void;
  notify: Notify;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const [editing, setEditing] = useState<Channel | null | 'new'>(null);
  const [busyId, setBusyId] = useState('');

  const filtered = channels.filter((channel) => {
    const provider = providers.find((item) => item.id === channel.provider);
    return (category === 'all' || provider?.category === category)
      && `${channel.name} ${channel.slug} ${provider?.name}`.toLowerCase().includes(query.toLowerCase());
  });

  const act = async (channel: Channel, action: 'toggle' | 'test' | 'delete') => {
    setBusyId(channel.id + action);
    try {
      if (action === 'toggle') {
        await api.updateChannel(channel.id, { enabled: !channel.enabled });
        notify('success', channel.enabled ? '频道已停用' : '频道已启用');
      } else if (action === 'test') {
        await api.testChannel(channel.id);
        notify('success', '测试通知已送达');
      } else {
        if (!confirm(`删除频道“${channel.name}”？历史投递使用中的频道将改为停用。`)) return;
        await api.deleteChannel(channel.id);
        notify('success', '频道已删除');
      }
      refresh();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '操作失败');
      refresh();
    } finally {
      setBusyId('');
    }
  };

  return (
    <>
      <header className="page-head">
        <h1>频道</h1>
        <Button variant="primary" icon={Plus} onClick={() => setEditing('new')}>添加频道</Button>
      </header>

      <div className="toolbar">
        <div className="filters">
          <div className="search">
            <Search size={15} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索频道" />
          </div>
          <select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="渠道分类">
            <option value="all">全部类型</option>
            <option value="chat">聊天协作</option>
            <option value="push">移动推送</option>
            <option value="email">邮件</option>
            <option value="sms">短信</option>
            <option value="universal">通用</option>
          </select>
        </div>
      </div>

      <section className="panel">
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>频道</th><th>服务</th><th>配置</th><th>测试状态</th><th>启用</th><th className="actions-col">操作</th></tr>
            </thead>
            <tbody>
              {filtered.map((channel) => {
                const provider = providers.find((item) => item.id === channel.provider);
                return (
                  <tr key={channel.id} className={!channel.enabled ? 'disabled-row' : ''}>
                    <td>
                      <strong className="table-title">{channel.name}</strong>
                      <code>{channel.slug}</code>
                    </td>
                    <td>
                      <span className="provider-cell">
                        <ProviderIcon provider={channel.provider} name={provider?.name} size={30} />
                        <span>
                          {provider?.name ?? channel.provider}
                          <small>{provider?.category}</small>
                        </span>
                      </span>
                    </td>
                    <td>
                      <span className="config-count"><KeyRound size={14} />{channel.configKeys.length} 项凭据</span>
                    </td>
                    <td>
                      {channel.lastTestStatus === 'untested'
                        ? <span className="muted">未测试</span>
                        : <Badge status={channel.lastTestStatus} />}
                    </td>
                    <td>
                      <button className={`switch ${channel.enabled ? 'on' : ''}`} aria-label={channel.enabled ? '停用频道' : '启用频道'} onClick={() => act(channel, 'toggle')} disabled={busyId !== ''}>
                        <span />
                      </button>
                    </td>
                    <td>
                      <div className="row-actions">
                        <IconButton label="发送测试" icon={busyId === channel.id + 'test' ? LoaderCircle : TestTube2} onClick={() => act(channel, 'test')} />
                        <IconButton label="编辑" icon={Edit3} onClick={() => setEditing(channel)} />
                        <IconButton label="删除" icon={Trash2} onClick={() => act(channel, 'delete')} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!filtered.length && (
            <Empty
              icon={MessageSquareText}
              title={channels.length ? '没有匹配的频道' : '还没有推送频道'}
              text={channels.length ? '调整搜索词或筛选条件。' : '添加一个 Telegram、企业微信或其他通知服务。'}
              action={!channels.length && <Button variant="primary" icon={Plus} onClick={() => setEditing('new')}>添加频道</Button>}
            />
          )}
        </div>
      </section>

      {editing && (
        <ChannelForm
          providers={providers}
          channel={editing === 'new' ? undefined : editing}
          close={() => setEditing(null)}
          saved={refresh}
          notify={notify}
        />
      )}
    </>
  );
}

