import { useEffect, useState } from 'react';
import { Activity, BookOpen, Check, Code2, Copy, Download, ExternalLink, Gauge, LoaderCircle, Send, Settings2, ShieldCheck, AlertTriangle, RefreshCw, Trash2 } from 'lucide-react';
import type { Channel, PlatformUsageSettings, PlatformUsageStatus, ProviderDefinition, RetentionSettings, UsageSettings, UsageSnapshot } from '../../shared/types';
import { api } from '../api';
import { Badge, Button, IconButton, Modal, type Notify } from './ui';
import { ProviderIcon } from './ProviderIcon';

type Meta = Awaited<ReturnType<typeof api.meta>>;

type UpdateStatus = {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  releaseNotes?: string;
  releaseUrl?: string;
  canApply: boolean;
  applyHint?: string;
};

/* ────────────────────────────────────────────────────────────
 * 系统状态：实例信息（URL 可复制）+ 各渠道测试结果（可在此直接测试）+ 版本更新。
 * ──────────────────────────────────────────────────────────── */

async function copyText(value: string, label: string, notify: Notify) {
  try {
    await navigator.clipboard.writeText(value);
    notify('success', `${label} 已复制`);
  } catch {
    notify('error', '复制失败，请手动选择文本');
  }
}

function CopyableRow({ label, value, notify }: { label: string; value: string; notify: Notify }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <code>{value}</code>
        <IconButton label={`复制${label}`} icon={Copy} onClick={() => copyText(value, label, notify)} />
      </dd>
    </div>
  );
}

function UsageMeter({ label, count, attempts, limit, warningPercent }: { label: string; count: number; attempts: number; limit: number; warningPercent: number }) {
  const percent = limit ? Math.min(100, Math.round(count / limit * 100)) : 0;
  const tone = limit && percent >= 100 ? 'limit' : limit && percent >= warningPercent ? 'warning' : '';
  return (
    <div className="usage-meter">
      <div><strong>{label}</strong><span>{count.toLocaleString()} 次投递 · {attempts.toLocaleString()} 次渠道尝试</span></div>
      <div className={`usage-track ${tone}`}><i style={{ width: `${percent}%` }} /></div>
      <small>{limit ? `${percent}% / 软限制 ${limit.toLocaleString()}` : '未设置软限制'}</small>
    </div>
  );
}

const formatPlatformValue = (value: number, unit: string) => {
  if (unit !== 'B') return `${value.toLocaleString()} ${unit}`;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let index = 0;
  while (amount >= 1000 && index < units.length - 1) { amount /= 1000; index += 1; }
  return `${amount.toLocaleString(undefined, { maximumFractionDigits: 2 })} ${units[index]}`;
};

const platformPlanLabel = (plan: PlatformUsageStatus['effectivePlan']) => ({
  'workers-free': 'Workers Free', 'workers-paid': 'Workers Paid', hobby: 'Hobby', pro: 'Pro', enterprise: 'Enterprise'
}[plan] ?? plan);

const platformPlanSummary = (plan: PlatformUsageStatus['effectivePlan']) => ({
  'workers-free': '100,000 请求/天 · 每次调用 10 ms CPU',
  'workers-paid': '10,000,000 请求/月 · 30,000,000 CPU ms/月',
  hobby: '1,000,000 函数调用/月 · 4 CPU 小时/月',
  pro: '按量计费，额度以 Vercel 控制台为准',
  enterprise: '企业合同额度，以平台控制台为准'
}[plan] ?? '以平台控制台为准');

function PlatformMeters({ status, warningPercent }: { status: PlatformUsageStatus; warningPercent: number }) {
  const hidden = new Set(status.settings.hiddenMetricKeys);
  const visible = status.metrics.filter((metric) => !hidden.has(metric.key));
  if (!visible.length) return <p className="platform-empty">没有选择要显示的指标，或尚未同步平台用量。</p>;
  return (
    <div className="platform-meters">
      {visible.map((metric) => {
        const percent = metric.limit ? Math.round(metric.value / metric.limit * 100) : undefined;
        const tone = percent === undefined ? 'unmetered' : percent >= 100 ? 'limit' : percent >= warningPercent ? 'warning' : '';
        const period = metric.period === 'day' ? '每日额度' : metric.period === 'month' ? '每月额度' : '单实例上限';
        return (
          <div className="usage-meter platform-meter" key={metric.key}>
            <div><span><strong>{metric.label}</strong>{metric.group && <small>{metric.group}</small>}</span><span>{formatPlatformValue(metric.value, metric.unit)}</span></div>
            <div className={`usage-track ${tone}`}><i style={{ width: `${percent === undefined ? 100 : Math.min(100, percent)}%` }} /></div>
            <small>{metric.limit
              ? `${percent}% / ${period} ${formatPlatformValue(metric.limit, metric.unit)}`
              : '平台提供实际值，但没有可直接比较的免费额度'}</small>
          </div>
        );
      })}
    </div>
  );
}

export function SystemPage({ meta, channels, providers, refresh, notify }: { meta: Meta; channels: Channel[]; providers: ProviderDefinition[]; refresh: () => Promise<void> | void; notify: Notify }) {
  const [testingId, setTestingId] = useState('');
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [confirmApply, setConfirmApply] = useState(false);
  const [showDocs, setShowDocs] = useState(false);

  const [usage, setUsage] = useState<UsageSnapshot>();
  const [usageDraft, setUsageDraft] = useState<UsageSettings>();
  const [savingUsage, setSavingUsage] = useState(false);
  useEffect(() => {
    let active = true;
    const loadUsage = async () => {
      try {
        const snapshot = await api.usage();
        if (active) { setUsage(snapshot); setUsageDraft((current) => current ?? snapshot.settings); }
      } catch { /* 页面仍可使用；下一轮自动重试 */ }
    };
    void loadUsage();
    const timer = window.setInterval(loadUsage, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  const saveUsage = async () => {
    if (!usageDraft) return;
    setSavingUsage(true);
    try {
      const snapshot = await api.setUsage(usageDraft);
      setUsage(snapshot);
      setUsageDraft(snapshot.settings);
      notify('success', '用量软限制已保存');
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '保存失败');
    } finally { setSavingUsage(false); }
  };

  const supportsPlatformUsage = meta.platform === 'cloudflare-workers' || meta.platform === 'vercel';
  const [platformUsage, setPlatformUsage] = useState<PlatformUsageStatus>();
  const [platformDraft, setPlatformDraft] = useState<PlatformUsageSettings>();
  const [platformToken, setPlatformToken] = useState('');
  const [savingPlatform, setSavingPlatform] = useState(false);
  const [refreshingPlatform, setRefreshingPlatform] = useState(false);
  const [platformConfigOpen, setPlatformConfigOpen] = useState(false);
  useEffect(() => {
    if (!supportsPlatformUsage) return;
    let active = true;
    const load = async () => {
      try {
        const status = await api.platformUsage();
        if (active) { setPlatformUsage(status); setPlatformDraft((current) => current ?? status.settings); }
      } catch { /* 下一轮自动重试 */ }
    };
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [supportsPlatformUsage]);

  const savePlatformUsage = async () => {
    if (!platformDraft) return;
    setSavingPlatform(true);
    try {
      let status = await api.setPlatformUsage({ ...platformDraft, ...(platformToken ? { apiToken: platformToken } : {}) });
      setPlatformToken('');
      let syncError = '';
      if (status.settings.enabled && status.configured) {
        try { status = await api.refreshPlatformUsage(); }
        catch (error) {
          syncError = error instanceof Error ? error.message : '同步失败';
          status = await api.platformUsage();
        }
      }
      setPlatformUsage(status);
      setPlatformDraft(status.settings);
      setPlatformConfigOpen(false);
      notify(syncError ? 'error' : 'success', syncError ? `设置已保存；同步失败：${syncError}` : '平台用量监控已保存');
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '保存失败');
    } finally { setSavingPlatform(false); }
  };

  const closePlatformConfig = () => {
    setPlatformDraft(platformUsage?.settings);
    setPlatformToken('');
    setPlatformConfigOpen(false);
  };

  const refreshPlatformUsage = async () => {
    setRefreshingPlatform(true);
    try {
      const status = await api.refreshPlatformUsage();
      setPlatformUsage(status);
      setPlatformDraft(status.settings);
      notify('success', '平台用量已刷新');
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '刷新失败');
      void api.platformUsage().then(setPlatformUsage).catch(() => undefined);
    } finally { setRefreshingPlatform(false); }
  };

  const reenablePlatformDelivery = async () => {
    try {
      const status = await api.reenablePlatformDelivery();
      setPlatformUsage(status);
      notify('success', '新推送已恢复');
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '恢复失败');
    }
  };

  /* 数据保留：加载当前配置，编辑后保存；立即清理按钮手动触发一轮 purge */
  const [retention, setRetention] = useState<RetentionSettings>();
  const [retentionDraft, setRetentionDraft] = useState<RetentionSettings>();
  const [savingRetention, setSavingRetention] = useState(false);
  const [purging, setPurging] = useState(false);
  useEffect(() => {
    void api.getRetention().then((settings) => { setRetention(settings); setRetentionDraft(settings); }).catch(() => undefined);
  }, []);
  const saveRetention = async () => {
    if (!retentionDraft) return;
    setSavingRetention(true);
    try {
      const saved = await api.setRetention(retentionDraft);
      setRetention(saved);
      setRetentionDraft(saved);
      notify('success', '保留策略已保存，将按计划自动清理');
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '保存失败');
    } finally {
      setSavingRetention(false);
    }
  };
  const purgeNow = async () => {
    setPurging(true);
    try {
      const result = await api.purgeNow();
      const total = result.deliveries + result.conversations + result.auditEvents;
      notify('success', total ? `已清理 ${total} 条过期数据` : '当前没有需要清理的数据');
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '清理失败');
    } finally {
      setPurging(false);
    }
  };

  const testChannel = async (channel: Channel) => {
    setTestingId(channel.id);
    try {
      await api.testChannel(channel.id);
      notify('success', `「${channel.name}」测试通知已送达`);
      // 等待刷新完成再清空 loading 态，确保 UI 展示的是最新测试结果
      await refresh();
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '测试失败');
      await refresh();
    } finally {
      setTestingId('');
    }
  };

  const checkUpdate = async () => {
    setChecking(true);
    try {
      const result = await api.checkUpdate();
      setUpdateStatus(result);
      // 后端在拉取失败时回退为 latestVersion === currentVersion，并附带 applyHint 错误文案；
      // 此时不是“已是最新”，而是检查失败，必须报错而非弹成功。
      const failed = !result.hasUpdate && result.latestVersion === result.currentVersion && /HTTP|失败|无法获取/.test(result.applyHint ?? '');
      if (result.hasUpdate) notify('success', `发现新版本 v${result.latestVersion}`);
      else if (failed) notify('error', result.applyHint ?? '检查更新失败');
      else notify('success', '已是最新版本');
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '检查更新失败');
    } finally {
      setChecking(false);
    }
  };

  const applyUpdate = async () => {
    setConfirmApply(false);
    setApplying(true);
    try {
      const result = await api.applyUpdate();
      if (result.success) {
        notify('success', result.message);
        if (result.needsRestart) {
          // 服务器约 1.5s 后重启。先等 2s 让旧进程退出，再轮询健康检查，
          // 一旦新进程上线立即刷新页面，避免在 5s 固定延迟内点击产生错误。
          setTimeout(() => pollAndReload(), 2000);
        }
      } else {
        notify('error', result.message);
      }
    } catch (error) {
      notify('error', error instanceof Error ? error.message : '应用更新失败');
    } finally {
      setApplying(false);
    }
  };

  // 重启轮询：每秒探测一次 /health，最多 30s；新进程上线就刷新页面。
  const pollAndReload = () => {
    const deadline = Date.now() + 30_000;
    const tick = async () => {
      try {
        const res = await fetch('/health', { cache: 'no-store' });
        if (res.ok) { window.location.reload(); return; }
      } catch { /* 服务器还在重启，继续轮询 */ }
      if (Date.now() < deadline) setTimeout(tick, 1000);
      else window.location.reload();
    };
    void tick();
  };

  return (
    <>
      <header className="page-head"><h1>系统</h1></header>

      <div className="system-grid">
        <section className="panel system-status">
          <div className="section-head">
            <h2>实例状态</h2>
            <span className="health"><i />运行正常</span>
          </div>
          <dl>
            <div><dt>版本</dt><dd><code>{meta.version}</code></dd></div>
            <div><dt>部署平台</dt><dd><code>{meta.platformProfile.label}</code></dd></div>
            <CopyableRow label="管理面板" value={meta.publicUrl} notify={notify} />
            <div>
              <dt>管理鉴权</dt>
              <dd>
                {meta.adminAuthRequired
                  ? <span><ShieldCheck size={15} />已启用</span>
                  : <span className="warning-text"><AlertTriangle size={15} />本地免鉴权</span>}
              </dd>
            </div>
          </dl>
          <div className="instance-actions">
            <span>MCP、REST 与兼容 API</span>
            <Button icon={BookOpen} onClick={() => setShowDocs(true)}>查看接入文档</Button>
          </div>
        </section>

        <section className="panel channel-test-panel">
          <div className="section-head">
            <h2>渠道测试结果</h2>
            <Activity size={15} className="muted" />
          </div>
          {channels.length ? (
            <div className="channel-test-list">
              {channels.map((channel) => {
                const provider = providers.find((item) => item.id === channel.provider);
                return (
                  <div className="channel-test-row" key={channel.id}>
                    <span className="channel-test-info">
                      <ProviderIcon provider={channel.provider} name={provider?.name} size={24} />
                      <span>
                        <strong>{channel.name}</strong>
                        <small>{provider?.name ?? channel.provider}</small>
                      </span>
                    </span>
                    <span className="channel-test-status">
                      {channel.lastTestStatus === 'untested'
                        ? <span className="muted">未测试</span>
                        : <Badge status={channel.lastTestStatus} />}
                      {channel.lastTestError && <span className="channel-test-error" title={channel.lastTestError}>{channel.lastTestError}</span>}
                    </span>
                    <IconButton
                      label="发送测试"
                      icon={testingId === channel.id ? LoaderCircle : Send}
                      spin={testingId === channel.id}
                      disabled={testingId !== ''}
                      onClick={() => testChannel(channel)}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="panel-note" style={{ borderTop: 0 }}>还没有频道。前往「频道」页添加一个通知渠道。</p>
          )}
        </section>

        <section className="panel usage-panel">
          <div className="section-head">
            <h2>额度与用量</h2>
            <span className="usage-refresh"><Gauge size={14} />每 30 秒刷新</span>
          </div>
          <div className="platform-limits">
            <div className="platform-limit-head">
              <span><strong>{meta.platformProfile.label}</strong>{supportsPlatformUsage && platformUsage?.settings.enabled ? <small>{platformPlanLabel(platformUsage.effectivePlan)}</small> : meta.platformProfile.freeTier && <small>{meta.platformProfile.freeTier}</small>}</span>
              <span className="platform-limit-actions">
                {meta.platformProfile.docsUrl && <a href={meta.platformProfile.docsUrl} target="_blank" rel="noreferrer">官方限制 <ExternalLink size={13} /></a>}
                {supportsPlatformUsage && platformUsage && platformDraft && <Button icon={Settings2} onClick={() => setPlatformConfigOpen(true)}>配置监控</Button>}
              </span>
            </div>
            {supportsPlatformUsage && platformUsage
              ? <p>{platformPlanSummary(platformUsage.effectivePlan)} · {platformUsage.settings.enabled ? (platformUsage.lastCheckedAt ? `上次同步 ${new Date(platformUsage.lastCheckedAt).toLocaleString()}` : '等待首次同步') : '监控未启用'}</p>
              : <p>{meta.platformProfile.usageNote}</p>}
          </div>
          {supportsPlatformUsage && platformUsage && platformDraft && (
            <div className="platform-monitor">
              <div className="platform-monitor-head">
                <div>
                  <strong>平台 API 用量</strong>
                  <small>{platformUsage.settings.enabled ? platformPlanLabel(platformUsage.effectivePlan) : '启用监控后显示平台指标'}</small>
                </div>
                <div className="platform-monitor-actions">
                  <span className={platformUsage.apiTokenConfigured ? 'ok-text' : 'muted'}>{platformUsage.apiTokenConfigured ? 'Token 已保存' : 'Token 未配置'}</span>
                  {platformDraft.enabled && <IconButton label="刷新平台用量" icon={refreshingPlatform ? LoaderCircle : RefreshCw} spin={refreshingPlatform} disabled={refreshingPlatform || !platformUsage.configured} onClick={refreshPlatformUsage} />}
                </div>
              </div>
              {platformUsage.settings.enabled && <>
              {platformUsage.deliveryDisabled && (
                <div className="platform-disabled">
                  <span><AlertTriangle size={15} /><span><strong>所有新推送已暂停</strong><small>{platformUsage.disabledReason}</small></span></span>
                  <Button onClick={reenablePlatformDelivery}>恢复推送</Button>
                </div>
              )}
              {platformUsage.lastError && <p className="platform-error"><AlertTriangle size={14} />{platformUsage.lastError}</p>}
              {platformUsage.warnings?.map((warning) => <p className="platform-warning" key={warning}><AlertTriangle size={14} />{warning}</p>)}
              <PlatformMeters status={platformUsage} warningPercent={platformDraft.warningPercent} />
              </>}
            </div>
          )}
          {usage && usageDraft ? (
            <div className="usage-body">
              <div className="usage-meters">
                <UsageMeter label="今天（UTC）" count={usage.today.deliveries} attempts={usage.today.attempts} limit={usageDraft.dailyDeliveryLimit} warningPercent={usageDraft.warningPercent} />
                <UsageMeter label="本月（UTC）" count={usage.month.deliveries} attempts={usage.month.attempts} limit={usageDraft.monthlyDeliveryLimit} warningPercent={usageDraft.warningPercent} />
              </div>
              <div className="usage-settings">
                <label>每日投递软限制<span className="optional">0 为不限</span>
                  <input type="number" min={0} max={10_000_000} value={usageDraft.dailyDeliveryLimit} onChange={(event) => setUsageDraft({ ...usageDraft, dailyDeliveryLimit: Number(event.target.value) })} />
                </label>
                <label>每月投递软限制<span className="optional">0 为不限</span>
                  <input type="number" min={0} max={100_000_000} value={usageDraft.monthlyDeliveryLimit} onChange={(event) => setUsageDraft({ ...usageDraft, monthlyDeliveryLimit: Number(event.target.value) })} />
                </label>
                <label>警告阈值<span className="optional">%</span>
                  <input type="number" min={50} max={100} value={usageDraft.warningPercent} onChange={(event) => setUsageDraft({ ...usageDraft, warningPercent: Number(event.target.value) })} />
                </label>
                <Button variant="primary" loading={savingUsage} disabled={savingUsage || JSON.stringify(usageDraft) === JSON.stringify(usage.settings)} onClick={saveUsage}>保存限制</Button>
              </div>
            </div>
          ) : <div className="modal-loading"><LoaderCircle className="spin" /></div>}
        </section>

        <section className="panel retention-panel">
          <div className="section-head">
            <h2>数据保留</h2>
            <IconButton label="立即清理" icon={purging ? LoaderCircle : Trash2} spin={purging} disabled={purging || savingRetention} onClick={purgeNow} />
          </div>
          {retentionDraft ? (
            <div className="retention-body">
              <label>投递记录保留天数<span className="optional">0 为永久</span>
                <input type="number" min={0} max={3650} value={retentionDraft.deliveriesDays} onChange={(event) => setRetentionDraft({ ...retentionDraft, deliveriesDays: Number(event.target.value) })} />
              </label>
              <label>会话记录保留天数<span className="optional">0 为永久</span>
                <input type="number" min={0} max={3650} value={retentionDraft.conversationsDays} onChange={(event) => setRetentionDraft({ ...retentionDraft, conversationsDays: Number(event.target.value) })} />
              </label>
              <label>审计日志保留天数<span className="optional">0 为永久</span>
                <input type="number" min={0} max={3650} value={retentionDraft.auditDays} onChange={(event) => setRetentionDraft({ ...retentionDraft, auditDays: Number(event.target.value) })} />
              </label>
              <div className="retention-actions">
                <Button
                  variant="primary"
                  loading={savingRetention}
                  disabled={savingRetention || JSON.stringify(retentionDraft) === JSON.stringify(retention)}
                  onClick={saveRetention}
                >
                  保存策略
                </Button>
              </div>
              <p className="panel-note">自动清理每日执行（Workers 按 alarm 周期、Vercel 按 cron）；只清理已完结投递与已回复/过期会话。0 天表示永久保留，默认全部永久。</p>
            </div>
          ) : (
            <div className="modal-loading"><LoaderCircle className="spin" /></div>
          )}
        </section>

        <section className="panel version-panel">
          <div className="section-head">
            <h2>版本更新</h2>
            <IconButton label="检查更新" icon={checking ? LoaderCircle : RefreshCw} spin={checking} disabled={checking || applying} onClick={checkUpdate} />
          </div>
          <div className="version-body">
            <div className="version-row">
              <span className="muted">当前版本</span>
              <code>v{meta.version}</code>
            </div>
            {updateStatus && (
              <>
                <div className="version-row">
                  <span className="muted">最新版本</span>
                  {updateStatus.hasUpdate
                    ? <code className="version-new">v{updateStatus.latestVersion}</code>
                    : <code>v{updateStatus.latestVersion}</code>}
                </div>
                {updateStatus.hasUpdate && (
                  <div className="version-update-banner">
                    <AlertTriangle size={16} />
                    <span>发现新版本 v{updateStatus.latestVersion}</span>
                  </div>
                )}
                {updateStatus.releaseNotes && (
                  <div className="version-notes">
                    <strong>更新说明</strong>
                    <pre>{updateStatus.releaseNotes}</pre>
                  </div>
                )}
                <div className="version-actions">
                  {updateStatus.releaseUrl && (
                    <Button icon={ExternalLink} onClick={() => window.open(updateStatus.releaseUrl, '_blank', 'noreferrer')}>查看 Release</Button>
                  )}
                  {updateStatus.hasUpdate && (
                    <Button
                      variant="primary"
                      icon={applying ? LoaderCircle : Download}
                      loading={applying}
                      disabled={!updateStatus.canApply || applying}
                      onClick={() => setConfirmApply(true)}
                    >
                      {updateStatus.canApply ? '应用更新' : '不支持应用内更新'}
                    </Button>
                  )}
                </div>
                {updateStatus.applyHint && <p className="version-hint">{updateStatus.applyHint}</p>}
              </>
            )}
            {!updateStatus && <p className="panel-note" style={{ borderTop: 0 }}>{meta.platformProfile.updateHint}</p>}
          </div>
        </section>
      </div>

      {showDocs && (
        <Modal title="接入文档" full onClose={() => setShowDocs(false)}>
          <div className="instance-modal-body">
            <div className="instance-summary">
              <div><span>部署平台</span><strong>{meta.platformProfile.label}</strong></div>
              <div><span>实例地址</span><code>{meta.publicUrl}</code></div>
              <div><span>管理鉴权</span><strong>{meta.adminAuthRequired ? '已启用' : '本地免鉴权'}</strong></div>
            </div>
            <section className="compatibility-docs">
              <div className="docs-heading"><Code2 size={18} /><div><h3>兼容端点</h3><p>以下协议可直接接入当前实例。</p></div></div>
              <div className="compatibility-list">
                {meta.compatibilityEndpoints.map((endpoint) => {
                  const endpointUrl = `${meta.publicUrl.replace(/\/$/, '')}${endpoint.path}`;
                  return (
                    <div className="compatibility-row" key={endpoint.id}>
                      <div className="compatibility-app">
                        {endpoint.provider ? <ProviderIcon provider={endpoint.provider} name={endpoint.name} size={26} /> : <Code2 size={20} />}
                        <span className="compatibility-title"><strong>{endpoint.name}</strong><code>{endpoint.method}</code></span>
                      </div>
                      <div className="compatibility-url"><code title={endpointUrl}>{endpointUrl}</code><IconButton label={`复制${endpoint.name}端点`} icon={Copy} onClick={() => copyText(endpointUrl, `${endpoint.name} 端点`, notify)} /></div>
                      <a href={endpoint.docsUrl} target="_blank" rel="noreferrer" aria-label={`${endpoint.name} 官方文档`}><ExternalLink size={14} /></a>
                      <dl><div><dt>鉴权</dt><dd>{endpoint.auth}</dd></div><div><dt>说明</dt><dd>{endpoint.description}</dd></div></dl>
                    </div>
                  );
                })}
              </div>
            </section>
          </div>
        </Modal>
      )}

      {platformConfigOpen && platformUsage && platformDraft && (
        <Modal title="平台用量监控" wide onClose={closePlatformConfig}>
          <div className="modal-body platform-config-body">
            <label className="platform-enable"><span><strong>启用监控</strong><small>每 15 分钟同步一次平台 API</small></span><input type="checkbox" checked={platformDraft.enabled} onChange={(event) => setPlatformDraft({ ...platformDraft, enabled: event.target.checked })} /></label>
            <section className="platform-config-section">
              <h3><span>1</span>平台连接</h3>
              <div className="platform-config-form">
                <label>{meta.platform === 'vercel' ? 'Vercel Access Token' : 'Cloudflare API Token'}<span className="optional">{platformUsage.apiTokenConfigured ? '留空保持不变' : '必填'}</span><input type="password" autoComplete="off" value={platformToken} placeholder={platformUsage.apiTokenConfigured ? '已加密保存' : ''} onChange={(event) => setPlatformToken(event.target.value)} /></label>
                {meta.platform === 'cloudflare-workers' ? <><label>Account ID<input value={platformDraft.accountId} onChange={(event) => setPlatformDraft({ ...platformDraft, accountId: event.target.value })} /></label><label>Worker 脚本名<input value={platformDraft.scriptName} onChange={(event) => setPlatformDraft({ ...platformDraft, scriptName: event.target.value })} /></label></> : <><label>Team ID<span className="optional">个人账户可留空</span><input value={platformDraft.teamId} onChange={(event) => setPlatformDraft({ ...platformDraft, teamId: event.target.value })} /></label><label>Project ID<span className="optional">留空统计全部</span><input value={platformDraft.projectId} onChange={(event) => setPlatformDraft({ ...platformDraft, projectId: event.target.value })} /></label></>}
              </div>
              {meta.platform === 'cloudflare-workers' && <p className="platform-permission-note">用量读取需要 Account Analytics:Read；自动识别套餐还需要 Billing:Read。</p>}
            </section>
            <section className="platform-config-section">
              <h3><span>2</span>套餐</h3>
              <label>套餐<span className="optional">无法授权 Billing:Read 时可手动选择</span><select value={platformDraft.plan} onChange={(event) => setPlatformDraft({ ...platformDraft, plan: event.target.value as PlatformUsageSettings['plan'] })}><option value="auto">自动识别</option>{meta.platform === 'vercel' ? <><option value="hobby">Hobby</option><option value="pro">Pro</option><option value="enterprise">Enterprise</option></> : <><option value="workers-free">Workers Free</option><option value="workers-paid">Workers Paid</option></>}</select></label>
              <div className="plan-preview"><strong>{platformPlanLabel(platformDraft.plan === 'auto' ? platformUsage.detectedPlan ?? platformUsage.effectivePlan : platformDraft.plan)}</strong><span>{platformPlanSummary(platformDraft.plan === 'auto' ? platformUsage.detectedPlan ?? platformUsage.effectivePlan : platformDraft.plan)}</span></div>
              {platformDraft.plan === 'auto' && (platformUsage.detectedPlan ? <small className="ok-text"><Check size={12} />已识别：{platformPlanLabel(platformUsage.detectedPlan)}</small> : platformUsage.planDetectionError ? <small className="platform-warning"><AlertTriangle size={12} />{platformUsage.planDetectionError}</small> : null)}
            </section>
            <details className="platform-advanced">
              <summary>告警与显示指标</summary>
              <label className="alert-setting-toggle"><span>启用告警</span><input type="checkbox" checked={platformDraft.alertsEnabled} onChange={(event) => setPlatformDraft({ ...platformDraft, alertsEnabled: event.target.checked })} /></label>
              {platformDraft.alertsEnabled && <div className="platform-config-form"><label>告警阈值<span className="optional">占套餐额度 %</span><input type="number" min={50} max={100} value={platformDraft.warningPercent} onChange={(event) => setPlatformDraft({ ...platformDraft, warningPercent: Number(event.target.value) })} /></label><label>达到阈值后<select value={platformDraft.action} onChange={(event) => setPlatformDraft({ ...platformDraft, action: event.target.value as PlatformUsageSettings['action'] })}><option value="notify">仅发送告警</option><option value="notify-and-disable">告警并暂停推送</option><option value="disable">仅暂停推送</option></select></label>{platformDraft.action !== 'disable' && <label>告警频道<select value={platformDraft.destination} onChange={(event) => setPlatformDraft({ ...platformDraft, destination: event.target.value })}><option value="">请选择</option>{channels.filter((channel) => channel.enabled).map((channel) => <option key={channel.id} value={channel.id}>{channel.name}</option>)}</select></label>}</div>}
              {platformUsage.metrics.length > 0 && <div className="metric-visibility"><div className="metric-visibility-head"><strong>显示指标</strong></div><div className="metric-checks">{platformUsage.metrics.map((metric) => <label key={metric.key} className="metric-check"><input type="checkbox" checked={!platformDraft.hiddenMetricKeys.includes(metric.key)} onChange={(event) => setPlatformDraft({ ...platformDraft, hiddenMetricKeys: event.target.checked ? platformDraft.hiddenMetricKeys.filter((key) => key !== metric.key) : [...platformDraft.hiddenMetricKeys, metric.key] })} /><span>{metric.label}</span></label>)}</div></div>}
            </details>
            <footer className="modal-actions"><Button onClick={closePlatformConfig}>取消</Button><Button variant="primary" loading={savingPlatform} disabled={savingPlatform || (!platformToken && JSON.stringify(platformDraft) === JSON.stringify(platformUsage.settings))} onClick={savePlatformUsage}>保存监控</Button></footer>
          </div>
        </Modal>
      )}

      {confirmApply && (
        <Modal title="确认应用更新" onClose={() => setConfirmApply(false)}>
          <div className="modal-body">
            <div className="warning-banner">
              <AlertTriangle size={18} />
              <div>
                <strong>更新过程中服务会短暂重启</strong>
                <p>系统将执行 git pull、重新安装依赖并构建，随后重启进程。请确保没有正在进行的投递任务。</p>
              </div>
            </div>
            <footer className="modal-actions">
              <Button onClick={() => setConfirmApply(false)}>取消</Button>
              <Button variant="primary" icon={Download} loading={applying} onClick={applyUpdate}>确认更新</Button>
            </footer>
          </div>
        </Modal>
      )}
    </>
  );
}
