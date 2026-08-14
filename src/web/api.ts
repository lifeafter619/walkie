import type { ApiKey, Channel, CredentialStatus, DashboardStats, Delivery, Destination, ProviderDefinition, Route } from '../shared/types';

const TOKEN_KEY = 'relaydock_admin_token';
export const getToken = () => localStorage.getItem(TOKEN_KEY) ?? '';
export const setToken = (token: string) => token ? localStorage.setItem(TOKEN_KEY, token) : localStorage.removeItem(TOKEN_KEY);

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

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
  meta: () => request<{ name: string; version: string; runtime: 'node' | 'cloudflare-workers'; adminAuthRequired: boolean; publicUrl: string; mcpEndpoint: string; mcpUrl: string }>('/api/meta'),
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
  revokeKey: (id: string) => request<{ success: boolean }>(`/api/admin/keys/${id}/revoke`, { method: 'POST' }),
  deliveries: (status = '') => request<{ deliveries: Delivery[] }>(`/api/admin/deliveries${status ? `?status=${status}` : ''}`),
  delivery: (id: string) => request<Delivery>(`/api/admin/deliveries/${id}`),
  send: (body: unknown) => request<Delivery>('/api/admin/send', { method: 'POST', body: JSON.stringify(body) }),
  credentials: () => request<CredentialStatus>('/api/admin/credentials'),
  rotateAdminToken: (body: unknown) => request<{ token: string }>('/api/admin/credentials/admin-token', { method: 'POST', body: JSON.stringify(body) }),
  rotateMasterKey: () => request<{ version: number; rotatedAt: string }>('/api/admin/credentials/master-key/rotate', { method: 'POST' })
};
