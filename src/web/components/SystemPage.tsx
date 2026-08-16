import { useState } from 'react';
import { Activity, Check, Copy, Download, ExternalLink, LoaderCircle, ShieldCheck, TestTube2, AlertTriangle, RefreshCw } from 'lucide-react';
import type { Channel, ProviderDefinition } from '../../shared/types';
import { api } from '../api';
import { Badge, Button, IconButton, Modal, Notify, type Notify as NotifyType } from './ui';
import { ProviderIcon } from './ProviderIcon';

type Meta = {
  version: string;
  runtime: 'node' | 'cloudflare-workers';
  publicUrl: string;
  mcpUrl: string;
  adminAuthRequired: boolean;
};

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

function CopyableRow({ label, value, notify }: { label: string; value: string; notify: NotifyType }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      notify('success', `${label} 已复制`);
    } catch {
      notify('error', '复制失败，请手动选择文本');
    }
  };
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <code>{value}</code>
        <IconButton label={`复制${label}`} icon={Copy} onClick={copy} />
      </dd>
    </div>
  );
}

export function SystemPage({ meta, channels, providers, refresh, notify }: { meta: Meta; channels: Channel[]; providers: ProviderDefinition[]; refresh: () => Promise<void> | void; notify: NotifyType }) {
  const [testingId, setTestingId] = useState('');
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [confirmApply, setConfirmApply] = useState(false);

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

  const restNotifyUrl = `${meta.publicUrl}/api/v1/notify`;
  const serverchanUrl = `${meta.publicUrl}/send/<AgentKey>.send`;

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
            <div><dt>运行时</dt><dd><code>{meta.runtime === 'cloudflare-workers' ? 'Cloudflare Workers' : 'Node.js'}</code></dd></div>
            <CopyableRow label="管理面板" value={meta.publicUrl} notify={notify} />
            <CopyableRow label="MCP 端点" value={meta.mcpUrl} notify={notify} />
            <CopyableRow label="REST 通知 API" value={restNotifyUrl} notify={notify} />
            <CopyableRow label="Server酱入口" value={serverchanUrl} notify={notify} />
            <div>
              <dt>管理鉴权</dt>
              <dd>
                {meta.adminAuthRequired
                  ? <span><ShieldCheck size={15} />已启用</span>
                  : <span className="warning-text"><AlertTriangle size={15} />本地免鉴权</span>}
              </dd>
            </div>
          </dl>
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
                      icon={testingId === channel.id ? LoaderCircle : TestTube2}
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
            {!updateStatus && <p className="panel-note" style={{ borderTop: 0 }}>点击右上角刷新按钮检查是否有新版本。Docker 与 Cloudflare Workers 部署均可检查；Node.js 独立部署（git clone）支持应用内自动更新。</p>}
          </div>
        </section>
      </div>

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
