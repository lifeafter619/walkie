import type { AdminToken, ApiKey, AuditEvent, Channel, Conversation, CredentialStatus, DashboardStats, Delivery, DeploymentPlatform, Destination, PlatformUsageInput, PlatformUsageStatus, ProviderDefinition, RetentionSettings, Route, Schedule, UsageSettings, UsageSnapshot } from '../shared/types';
import type { CompatibilityEndpoint, PlatformProfile } from '../shared/platform';

const TOKEN_KEY = 'walkie_admin_token';
export const getToken = () => localStorage.getItem(TOKEN_KEY) ?? '';
export const setToken = (token: string) => token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY);

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

/** 服务端 /api/admin/deliveries 每页条数（app.ts 的 limit 默认值）；满页即代表可能还有更早的记录 */
export const DELIVERY_PAGE_SIZE = 100;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...init.headers }
  });
  if (response.status === 204) return undefined as T;
  const payload = await response.json().catch(() => ({})) as { error?: string };
  if (!response.ok) throw new ApiError(response.status, payload.error || `请求失败（${response.status}）`);
  return payload as T;
}

export const api = {
  meta: () => request<{ name: string; version: string; runtime: 'node' | 'cloudflare-workers'; platform: DeploymentPlatform; platformProfile: PlatformProfile; compatibilityEndpoints: CompatibilityEndpoint[]; adminAuthRequired: boolean; publicUrl: string; mcpEndpoint: string; mcpUrl: string }>('/api/meta'),
  session: () => request<{ authenticated: boolean }>('/api/admin/session'),
  stats: () => request<DashboardStats>('/api/admin/stats'),
  providers: () => request<{ providers: ProviderDefinition[] }>('/api/admin/providers'),
  destinations: () => request<{ destinations: Destination[] }>('/api/admin/destinations'),
  channels: () => request<{ channels: Channel[] }>('/api/admin/channels'),
  createChannel: (body: unknown) => request<Channel>('/api/admin/channels', { method: 'POST', body: JSON.stringify(body) }),
  updateChannel: (id: string, body: unknown) => request<Channel>(`/api/admin/channels/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteChannel: (id: string) => request<void>(`/api/admin/channels/${id}`, { method: 'DELETE' }),
  testChannel: (id: string) => request<{ success: boolean }>(`/api/admin/channels/${id}/test`, { method: 'POST' }),
  routes: () => request<{ routes: Route[] }>('/api/admin/routes'),
  createRoute: (body: unknown) => request<Route>('/api/admin/routes', { method: 'POST', body: JSON.stringify(body) }),
  updateRoute: (id: string, body: unknown) => request<Route>(`/api/admin/routes/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deleteRoute: (id: string) => request<void>(`/api/admin/routes/${id}`, { method: 'DELETE' }),
  keys: () => request<{ keys: ApiKey[] }>('/api/admin/keys'),
  createKey: (body: unknown) => request<{ apiKey: ApiKey; secret: string }>('/api/admin/keys', { method: 'POST', body: JSON.stringify(body) }),
  updateKey: (id: string, body: unknown) => request<ApiKey>(`/api/admin/keys/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  revokeKey: (id: string) => request<{ success: boolean }>(`/api/admin/keys/${id}/revoke`, { method: 'POST' }),
  restoreKey: (id: string) => request<{ success: boolean }>(`/api/admin/keys/${id}/restore`, { method: 'POST' }),
  deleteKey: (id: string) => request<void>(`/api/admin/keys/${id}`, { method: 'DELETE' }),
  deliveries: (status = '', q = '', before = '') => {
    const query = new URLSearchParams();
    if (status) query.set('status', status);
    if (q) query.set('q', q);
    if (before) query.set('before', before);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return request<{ deliveries: Delivery[] }>(`/api/admin/deliveries${suffix}`);
  },
  delivery: (id: string) => request<Delivery>(`/api/admin/deliveries/${id}`),
  send: (body: unknown) => request<Delivery>('/api/admin/send', { method: 'POST', body: JSON.stringify(body) }),
  schedules: () => request<{ schedules: Schedule[] }>('/api/admin/schedules'),
  cancelSchedule: (id: string) => request<Schedule>(`/api/admin/schedules/${id}/cancel`, { method: 'POST' }),
  conversations: (pending = false) => request<{ conversations: Conversation[] }>(`/api/admin/conversations${pending ? '?pending=1' : ''}`),
  replyConversation: (id: string, reply: string) => request<{ success: boolean }>(`/api/admin/conversations/${id}/reply`, { method: 'POST', body: JSON.stringify({ reply }) }),
  credentials: () => request<CredentialStatus>('/api/admin/credentials'),
  auditEvents: (params: { limit?: number; actor?: string; action?: string } = {}) => {
    const query = new URLSearchParams();
    if (params.limit) query.set('limit', String(params.limit));
    if (params.actor) query.set('actor', params.actor);
    if (params.action) query.set('action', params.action);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return request<{ events: AuditEvent[] }>(`/api/admin/audit${suffix}`);
  },
  createAdminToken: (body: unknown) => request<{ token: string; adminToken: AdminToken }>('/api/admin/credentials/admin-token', { method: 'POST', body: JSON.stringify(body) }),
  revokeAdminToken: (id: string) => request<void>(`/api/admin/credentials/admin-tokens/${id}`, { method: 'DELETE' }),
  restoreAdminToken: (id: string) => request<{ success: boolean }>(`/api/admin/credentials/admin-tokens/${id}/restore`, { method: 'POST' }),
  rotateMasterKey: () => request<{ version: number; rotatedAt: string }>('/api/admin/credentials/master-key/rotate', { method: 'POST' }),
  checkUpdate: () => request<{ currentVersion: string; latestVersion: string; hasUpdate: boolean; releaseNotes?: string; releaseUrl?: string; canApply: boolean; applyHint?: string }>('/api/admin/update/check'),
  applyUpdate: () => request<{ success: boolean; message: string; needsRestart: boolean }>('/api/admin/update/apply', { method: 'POST' }),
  getRetention: () => request<RetentionSettings>('/api/admin/retention'),
  setRetention: (body: RetentionSettings) => request<RetentionSettings>('/api/admin/retention', { method: 'PUT', body: JSON.stringify(body) }),
  purgeNow: () => request<{ deliveries: number; conversations: number; auditEvents: number }>('/api/admin/retention/purge', { method: 'POST' }),
  usage: () => request<UsageSnapshot>('/api/admin/usage'),
  setUsage: (body: UsageSettings) => request<UsageSnapshot>('/api/admin/usage', { method: 'PUT', body: JSON.stringify(body) }),
  platformUsage: () => request<PlatformUsageStatus>('/api/admin/platform-usage'),
  setPlatformUsage: (body: PlatformUsageInput) => request<PlatformUsageStatus>('/api/admin/platform-usage', { method: 'PUT', body: JSON.stringify(body) }),
  refreshPlatformUsage: () => request<PlatformUsageStatus>('/api/admin/platform-usage/refresh', { method: 'POST' }),
  reenablePlatformDelivery: () => request<PlatformUsageStatus>('/api/admin/platform-usage/reenable', { method: 'POST' }),
  clearAudit: () => request<{ deleted: number }>('/api/admin/audit', { method: 'DELETE' })
};
