import type {
  DeploymentPlatform,
  PlatformUsageInput,
  PlatformUsageMetric,
  PlatformUsageSettings,
  PlatformUsageStatus
} from '../shared/types.js';
import type { RelayRepository } from './database.js';
import type { NotificationService } from './notifications.js';

type SupportedPlatform = Extract<DeploymentPlatform, 'cloudflare-workers' | 'vercel'>;
type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface UsageResult {
  metrics: PlatformUsageMetric[];
  periodStart: string;
  periodEnd: string;
  periodKey: string;
  warnings?: string[];
}

const CHECK_INTERVAL_MS = 15 * 60_000;
const MAX_VERCEL_RESPONSE_BYTES = 2 * 1024 * 1024;

const utcDayStart = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
const utcMonthStart = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
const number = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

type ResolvedPlan = Exclude<PlatformUsageSettings['plan'], 'auto'>;

const defaultPlan = (platform: SupportedPlatform): ResolvedPlan => platform === 'vercel' ? 'hobby' : 'workers-free';

const normalizePlan = (value: unknown, platform: SupportedPlatform): ResolvedPlan | undefined => {
  const plan = String(value ?? '').toLowerCase();
  if (platform === 'vercel') {
    if (plan.includes('enterprise')) return 'enterprise';
    if (plan === 'pro' || plan.includes('pro')) return 'pro';
    if (plan === 'hobby' || plan.includes('hobby') || plan === 'free') return 'hobby';
  } else {
    if (plan.includes('free')) return 'workers-free';
    if (plan.includes('enterprise')) return 'workers-paid';
    if (plan.includes('paid') || plan.includes('unbound') || plan.includes('standard')) return 'workers-paid';
  }
  return undefined;
};

export async function detectCloudflarePlan(token: string, accountId: string, requester: Fetcher = fetch): Promise<ResolvedPlan> {
  const response = await requester(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/subscriptions`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(15_000)
  });
  const payload = await response.json() as { result?: Array<{ state?: string; rate_plan?: { id?: string; public_name?: string; name?: string; scope?: string; sets?: string[] } }>; errors?: Array<{ message?: string }> };
  if (!response.ok) {
    const message = payload.errors?.map((item) => item.message).filter(Boolean).join('；') || `Cloudflare 订阅 API HTTP ${response.status}`;
    throw new Error(`${message}；自动识别套餐需要 Account > Billing > Read，也可以手动选择套餐`);
  }
  const plans = (payload.result ?? [])
    .filter((item) => !item.state || ['trial', 'provisioned', 'paid'].includes(item.state.toLowerCase()))
    .map((item) => [item, [item.rate_plan?.id, item.rate_plan?.public_name, item.rate_plan?.name, item.rate_plan?.scope, ...(item.rate_plan?.sets ?? [])].filter(Boolean).join(' ')] as const)
    .filter(([, description]) => description.toLowerCase().includes('worker'))
    .map(([, description]) => normalizePlan(description, 'cloudflare-workers'));
  return plans.includes('workers-paid') ? 'workers-paid' : 'workers-free';
}

export async function detectVercelPlan(token: string, settings: PlatformUsageSettings, requester: Fetcher = fetch): Promise<ResolvedPlan> {
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
  let value: unknown;
  if (settings.projectId) {
    const url = new URL(`https://api.vercel.com/v9/projects/${encodeURIComponent(settings.projectId)}`);
    if (settings.teamId) url.searchParams.set('teamId', settings.teamId);
    const response = await requester(url, { headers, signal: AbortSignal.timeout(15_000) });
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(`Vercel Project API HTTP ${response.status}`);
    value = payload.plan ?? payload.billingPlan;
  } else {
    const response = await requester('https://api.vercel.com/v2/user', { headers, signal: AbortSignal.timeout(15_000) });
    const payload = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error(`Vercel User API HTTP ${response.status}`);
    const user = payload.user && typeof payload.user === 'object' ? payload.user as Record<string, unknown> : payload;
    const billing = user.billing && typeof user.billing === 'object' ? user.billing as Record<string, unknown> : {};
    value = billing.plan ?? user.plan ?? payload.plan;
  }
  const plan = normalizePlan(value, 'vercel');
  if (!plan) throw new Error('Vercel API 未返回可识别的套餐，请手动选择');
  return plan;
}

export function defaultPlatformUsageSettings(platform: SupportedPlatform): PlatformUsageSettings {
  return {
    enabled: false,
    alertsEnabled: false,
    plan: 'auto',
    hiddenMetricKeys: [],
    accountId: '',
    scriptName: platform === 'cloudflare-workers' ? 'walkie' : '',
    teamId: '',
    projectId: '',
    warningPercent: 80,
    action: 'notify',
    destination: ''
  };
}

async function fetchCloudflareAccount<T extends object>(
  token: string,
  query: string,
  variables: Record<string, unknown>,
  requester: Fetcher
): Promise<T> {
  const response = await requester('https://api.cloudflare.com/client/v4/graphql', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000)
  });
  const payload = await response.json() as {
    errors?: Array<{ message?: string }>;
    data?: { viewer?: { accounts?: T[] } };
  };
  if (!response.ok || payload.errors?.length) throw new Error(payload.errors?.map((item) => item.message).filter(Boolean).join('；') || `Cloudflare API HTTP ${response.status}`);
  const account = payload.data?.viewer?.accounts?.[0];
  if (!account) throw new Error('Cloudflare Account ID 不存在，或 Token 无 Account Analytics:Read 权限');
  return account;
}

export async function fetchCloudflareUsage(
  token: string,
  settings: PlatformUsageSettings,
  requester: Fetcher = fetch,
  current = new Date()
): Promise<UsageResult> {
  const selectedPlan = normalizePlan(settings.plan, 'cloudflare-workers') ?? 'workers-free';
  const start = selectedPlan === 'workers-paid' ? utcMonthStart(current) : utcDayStart(current);
  const period = selectedPlan === 'workers-paid' ? 'month' as const : 'day' as const;
  const accountTag = settings.accountId;
  const dayVariables = { accountTag, start: start.toISOString().slice(0, 10), end: current.toISOString().slice(0, 10) };
  const requests = [
    fetchCloudflareAccount<{
      workersInvocationsAdaptive?: Array<{ sum?: { requests?: number; errors?: number; subrequests?: number } }>;
    }>(token, `query WorkerUsage($accountTag: string!, $filter: AccountWorkersInvocationsAdaptiveFilter_InputObject) {
        viewer { accounts(filter: { accountTag: $accountTag }) {
          workersInvocationsAdaptive(limit: 10000, filter: $filter) { sum { requests errors subrequests } }
        } }
      }`, {
        accountTag,
        filter: { scriptName: settings.scriptName, datetime_geq: start.toISOString(), datetime_leq: current.toISOString() }
      }, requester),
    fetchCloudflareAccount<{
      durableObjectsInvocationsAdaptiveGroups?: Array<{ sum?: { requests?: number; responseBodySize?: number } }>;
    }>(token, `query DurableObjectInvocations($accountTag: string!, $start: Date!, $end: Date!) {
        viewer { accounts(filter: { accountTag: $accountTag }) {
          durableObjectsInvocationsAdaptiveGroups(limit: 10000, filter: { date_geq: $start, date_leq: $end }) { sum { requests responseBodySize } }
        } }
      }`, dayVariables, requester),
    fetchCloudflareAccount<{
      durableObjectsSqlStorageGroups?: Array<{ max?: { storedBytes?: number } }>;
    }>(token, `query DurableObjectSqlStorage($accountTag: string!, $start: Date!, $end: Date!) {
        viewer { accounts(filter: { accountTag: $accountTag }) {
          durableObjectsSqlStorageGroups(limit: 10000, filter: { date_geq: $start, date_leq: $end }) { max { storedBytes } }
        } }
      }`, dayVariables, requester),
    fetchCloudflareAccount<{
      durableObjectsPeriodicGroups?: Array<{ sum?: { cpuTime?: number } }>;
    }>(token, `query DurableObjectPeriodic($accountTag: string!, $start: Date!, $end: Date!) {
        viewer { accounts(filter: { accountTag: $accountTag }) {
          durableObjectsPeriodicGroups(limit: 10000, filter: { date_geq: $start, date_leq: $end }) { sum { cpuTime } }
        } }
      }`, dayVariables, requester)
  ] as const;
  const [worker, invocations, storage, periodic] = await Promise.allSettled(requests);
  if (worker.status === 'rejected') throw worker.reason;
  const workerRows = worker.value.workersInvocationsAdaptive ?? [];
  const workerTotal = (key: 'requests' | 'errors' | 'subrequests') => workerRows.reduce((sum, row) => sum + number(row.sum?.[key]), 0);
  const metrics: PlatformUsageMetric[] = [
    { key: 'worker:requests', label: 'Worker 请求', value: workerTotal('requests'), unit: '次', limit: selectedPlan === 'workers-paid' ? 10_000_000 : 100_000, period, group: 'Workers' },
    { key: 'worker:errors', label: 'Worker 错误', value: workerTotal('errors'), unit: '次', group: 'Workers' },
    { key: 'worker:subrequests', label: 'Worker 子请求', value: workerTotal('subrequests'), unit: '次', group: 'Workers' }
  ];
  if (invocations.status === 'fulfilled') {
    const rows = invocations.value.durableObjectsInvocationsAdaptiveGroups ?? [];
    metrics.push(
      { key: 'durable-objects:requests', label: 'Durable Object 请求', value: rows.reduce((sum, row) => sum + number(row.sum?.requests), 0), unit: '次', limit: selectedPlan === 'workers-paid' ? 1_000_000 : 100_000, period, group: 'Durable Objects' },
      { key: 'durable-objects:response-bytes', label: 'DO 响应流量', value: rows.reduce((sum, row) => sum + number(row.sum?.responseBodySize), 0), unit: 'B', group: 'Durable Objects' }
    );
  }
  if (storage.status === 'fulfilled') {
    const rows = storage.value.durableObjectsSqlStorageGroups ?? [];
    metrics.push({
      key: 'durable-objects:sqlite-storage', label: 'DO SQLite 存储',
      value: rows.reduce((max, row) => Math.max(max, number(row.max?.storedBytes)), 0),
      unit: 'B', limit: selectedPlan === 'workers-paid' ? 5_000_000_000 : 1_000_000_000, period: 'current', group: 'Durable Objects'
    });
  }
  if (periodic.status === 'fulfilled') {
    const rows = periodic.value.durableObjectsPeriodicGroups ?? [];
    metrics.push({ key: 'durable-objects:cpu-time', label: 'DO CPU 时间', value: rows.reduce((sum, row) => sum + number(row.sum?.cpuTime), 0), unit: 'ms', group: 'Durable Objects' });
  }
  const optional = [invocations, storage, periodic];
  const labels = ['DO 请求', 'DO SQLite 存储', 'DO CPU 时间'];
  return {
    metrics,
    periodStart: start.toISOString(),
    periodEnd: current.toISOString(),
    periodKey: start.toISOString().slice(0, 10),
    warnings: optional.flatMap((result, index) => result.status === 'rejected'
      ? [`${labels[index]}：${result.reason instanceof Error ? result.reason.message : String(result.reason)}`]
      : [])
  };
}

function vercelPlanLimit(plan: ResolvedPlan, service: string, unit: string): number | undefined {
  if (plan !== 'hobby') return undefined;
  const name = service.toLowerCase();
  const normalizedUnit = unit.toLowerCase().replace(/[\s_-]/g, '');
  if (normalizedUnit.startsWith('invocation')) return 1_000_000;
  if (name.includes('active cpu')) {
    if (/^(h|hr|hrs|hour|hours)$/.test(normalizedUnit)) return 4;
    if (/^(s|sec|secs|second|seconds)$/.test(normalizedUnit)) return 14_400;
    if (/^(ms|millisecond|milliseconds)$/.test(normalizedUnit)) return 14_400_000;
  }
  if (name.includes('provisioned memory')) {
    if (/^(gbh|gbhour|gbhours)$/.test(normalizedUnit)) return 360;
    if (/^(gbs|gbsecond|gbseconds)$/.test(normalizedUnit)) return 1_296_000;
  }
}

export async function parseVercelJsonLines(response: Response): Promise<Record<string, unknown>[]> {
  if (!response.body) return [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const rows: Record<string, unknown>[] = [];
  let buffer = '';
  let bytes = 0;
  const parseLine = (line: string) => {
    const trimmed = line.trim();
    if (trimmed) rows.push(JSON.parse(trimmed) as Record<string, unknown>);
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > MAX_VERCEL_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error('Vercel 用量响应超过 2 MB，请填写 Team ID 缩小账户范围');
    }
    buffer += decoder.decode(value, { stream: true });
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      parseLine(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
    }
  }
  buffer += decoder.decode();
  parseLine(buffer);
  return rows;
}

export async function fetchVercelUsage(
  token: string,
  settings: PlatformUsageSettings,
  requester: Fetcher = fetch,
  current = new Date()
): Promise<UsageResult> {
  const start = utcMonthStart(current);
  const url = new URL('https://api.vercel.com/v1/billing/charges');
  url.searchParams.set('from', start.toISOString());
  url.searchParams.set('to', current.toISOString());
  if (settings.teamId) url.searchParams.set('teamId', settings.teamId);
  const response = await requester(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Vercel API HTTP ${response.status}`);
  const rows = await parseVercelJsonLines(response);
  const totals = new Map<string, PlatformUsageMetric>();
  let billedCost = 0;
  let effectiveCost = 0;
  for (const row of rows) {
    const tags = row.Tags && typeof row.Tags === 'object' ? row.Tags as Record<string, unknown> : {};
    if (settings.projectId && String(tags.ProjectId ?? '') !== settings.projectId) continue;
    const service = String(row.ServiceName ?? '').trim();
    const unit = String(row.ConsumedUnit ?? '').trim();
    if (service && unit) {
      const key = `usage:${encodeURIComponent(service)}:${encodeURIComponent(unit)}`;
      const existing = totals.get(key);
      const limit = vercelPlanLimit(normalizePlan(settings.plan, 'vercel') ?? 'hobby', service, unit);
      totals.set(key, { key, label: service, unit, value: (existing?.value ?? 0) + number(row.ConsumedQuantity), group: 'Vercel', ...(limit ? { limit, period: 'month' as const } : {}) });
    }
    billedCost += number(row.BilledCost);
    effectiveCost += number(row.EffectiveCost);
  }
  totals.set('cost:billed', { key: 'cost:billed', label: '账单成本', value: billedCost, unit: 'USD' });
  totals.set('cost:effective', { key: 'cost:effective', label: '有效成本', value: effectiveCost, unit: 'USD' });
  return {
    metrics: [...totals.values()].sort((left, right) => left.label.localeCompare(right.label)),
    periodStart: start.toISOString(),
    periodEnd: current.toISOString(),
    periodKey: start.toISOString().slice(0, 7)
  };
}

export class PlatformUsageMonitor {
  constructor(
    private readonly repository: RelayRepository,
    private readonly notifications: NotificationService,
    private readonly platform: SupportedPlatform,
    private readonly requester: Fetcher = fetch
  ) {}

  private async settings(): Promise<PlatformUsageSettings> {
    const defaults = defaultPlatformUsageSettings(this.platform);
    const stored = await this.repository.getPlatformUsageSettings() as Partial<PlatformUsageSettings> & { metricKey?: unknown; threshold?: unknown };
    const legacyPercent = stored.metricKey === 'requests' && typeof stored.threshold === 'number'
      ? Math.round(stored.threshold / 100_000 * 100)
      : defaults.warningPercent;
    return {
      enabled: stored.enabled ?? defaults.enabled,
      alertsEnabled: stored.alertsEnabled ?? defaults.alertsEnabled,
      plan: stored.plan ?? defaults.plan,
      hiddenMetricKeys: stored.hiddenMetricKeys ?? defaults.hiddenMetricKeys,
      accountId: stored.accountId ?? defaults.accountId,
      scriptName: stored.scriptName ?? defaults.scriptName,
      teamId: stored.teamId ?? defaults.teamId,
      projectId: stored.projectId ?? defaults.projectId,
      warningPercent: Math.max(50, Math.min(100, stored.warningPercent ?? legacyPercent)),
      action: stored.action ?? defaults.action,
      destination: stored.destination ?? defaults.destination
    };
  }

  private async status(): Promise<PlatformUsageStatus> {
    const [settings, runtime, apiTokenConfigured] = await Promise.all([
      this.settings(), this.repository.getPlatformUsageRuntime(), this.repository.hasPlatformUsageToken()
    ]);
    const configured = apiTokenConfigured && (this.platform === 'vercel' || Boolean(settings.accountId && settings.scriptName));
    const effectivePlan = settings.plan === 'auto' ? runtime.detectedPlan ?? defaultPlan(this.platform) : settings.plan;
    return { platform: this.platform, configured, apiTokenConfigured, effectivePlan, settings, ...runtime };
  }

  async getStatus(refreshIfStale = false): Promise<PlatformUsageStatus> {
    if (refreshIfStale && await this.isDue()) {
      try { await this.refresh(); }
      catch { /* 状态中保留错误，管理页仍可打开 */ }
    }
    return this.status();
  }

  async configure(input: PlatformUsageInput): Promise<PlatformUsageStatus> {
    const settings: PlatformUsageSettings = { ...input };
    delete (settings as PlatformUsageSettings & { apiToken?: string }).apiToken;
    // Legacy callers expressed opt-in by selecting a non-default action.
    if (settings.action !== 'notify') settings.alertsEnabled = true;
    const hasToken = Boolean(input.apiToken) || await this.repository.hasPlatformUsageToken();
    if (settings.enabled && !hasToken) throw new Error('启用监控前请填写平台 API Token');
    if (settings.enabled && this.platform === 'cloudflare-workers' && (!settings.accountId || !settings.scriptName)) throw new Error('Cloudflare 监控需要 Account ID 和 Worker 脚本名');
    if (settings.enabled && settings.alertsEnabled && settings.action !== 'disable') {
      const destination = (await this.repository.listDestinations()).find((item) => item.id === settings.destination && item.enabled);
      if (!destination) throw new Error('告警通知频道不存在或已禁用');
    }
    if (input.apiToken) await this.repository.setPlatformUsageToken(input.apiToken);
    await this.repository.setPlatformUsageSettings(settings);
    if (hasToken && settings.plan === 'auto') {
      try {
        const token = await this.repository.getPlatformUsageToken();
        const detected = token
          ? this.platform === 'cloudflare-workers'
            ? await detectCloudflarePlan(token, settings.accountId, this.requester)
            : await detectVercelPlan(token, settings, this.requester)
          : undefined;
        await this.repository.recordPlatformUsageDetection(detected, undefined);
      } catch (error) {
        await this.repository.recordPlatformUsageDetection(undefined, error instanceof Error ? error.message : String(error));
      }
    } else if (settings.plan !== 'auto') {
      await this.repository.recordPlatformUsageDetection(undefined, undefined);
    }
    return this.status();
  }

  async refresh(): Promise<PlatformUsageStatus> {
    const currentStatus = await this.status();
    const settings = { ...currentStatus.settings, plan: currentStatus.effectivePlan };
    const token = await this.repository.getPlatformUsageToken();
    if (!token) throw new Error('尚未配置平台 API Token');
    if (this.platform === 'cloudflare-workers' && (!settings.accountId || !settings.scriptName)) throw new Error('Cloudflare 监控需要 Account ID 和 Worker 脚本名');

    let result: UsageResult;
    try {
      result = this.platform === 'cloudflare-workers'
        ? await fetchCloudflareUsage(token, settings, this.requester)
        : await fetchVercelUsage(token, settings, this.requester);
      await this.repository.recordPlatformUsageSuccess(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.repository.recordPlatformUsageError(message);
      throw error;
    }

    if (settings.enabled && (settings.alertsEnabled || settings.action !== 'notify')) {
      const exceeded = result.metrics.filter((metric) => metric.limit && metric.value / metric.limit * 100 >= settings.warningPercent);
      for (const metric of exceeded) {
        try {
          const alertKey = `platform:${result.periodKey}:${metric.key}:${settings.warningPercent}:${settings.action}:${settings.destination}`.slice(0, 200);
          if (settings.action !== 'disable') {
            await this.notifications.send({
              destination: settings.destination,
              title: 'Walkie 平台用量告警',
              body: `${metric.label}已使用 ${metric.value.toLocaleString()} / ${metric.limit!.toLocaleString()} ${metric.unit}，达到免费额度的 ${Math.round(metric.value / metric.limit! * 100)}%。`,
              severity: 'critical',
              metadata: { platform: this.platform, metric: metric.key, warningPercent: settings.warningPercent, limit: metric.limit },
              idempotencyKey: alertKey
            }, 'system:platform-usage', undefined, { bypassLimits: true });
          }
          if (settings.action !== 'notify') {
            await this.repository.setPlatformDeliveryDisabled(true, `${metric.label}达到免费额度的 ${settings.warningPercent}%`);
          }
        } catch (error) {
          const message = `阈值动作失败：${error instanceof Error ? error.message : String(error)}`;
          await this.repository.recordPlatformUsageError(message);
          throw new Error(message);
        }
      }
    }
    return this.status();
  }

  async reenableDelivery(): Promise<PlatformUsageStatus> {
    await this.repository.setPlatformDeliveryDisabled(false);
    return this.status();
  }

  async nextCheckAt(): Promise<number | undefined> {
    const status = await this.status();
    if (!status.settings.enabled || !status.configured) return;
    const last = status.lastAttemptAt ? new Date(status.lastAttemptAt).getTime() : 0;
    return Math.max(Date.now() + 250, last + CHECK_INTERVAL_MS);
  }

  async isDue(): Promise<boolean> {
    const next = await this.nextCheckAt();
    return next !== undefined && next <= Date.now() + 250;
  }

  async refreshIfDue(): Promise<PlatformUsageStatus | undefined> {
    return await this.isDue() ? this.refresh() : undefined;
  }
}
