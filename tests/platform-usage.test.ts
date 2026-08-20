import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RelayRepository } from '../src/server/database.js';
import { createNodeRepository } from '../src/server/database-node.js';
import { NotificationService } from '../src/server/notifications.js';
import { defaultPlatformUsageSettings, detectCloudflarePlan, detectVercelPlan, fetchCloudflareUsage, fetchVercelUsage, PlatformUsageMonitor } from '../src/server/platform-usage.js';

const repositories: RelayRepository[] = [];
afterEach(() => repositories.splice(0).forEach((repository) => repository.close()));

async function setup() {
  const repository = await createNodeRepository(':memory:', randomBytes(32));
  repositories.push(repository);
  const notifications = new NotificationService(repository);
  return { repository, notifications };
}

const cloudflareResponse = (requests: number) => new Response(JSON.stringify({
  data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests, errors: 2, subrequests: 11 } }] }] } }
}), { status: 200, headers: { 'content-type': 'application/json' } });

describe('platform usage monitoring', () => {
  it('detects platform plans and leaves manual fallback possible', async () => {
    const cloudflare = await detectCloudflarePlan('cf-token', 'account-id', async (input, init) => {
      expect(String(input)).toContain('/accounts/account-id/subscriptions');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer cf-token');
      return new Response(JSON.stringify({ result: [
        { state: 'Paid', rate_plan: { id: 'zone_pro', public_name: 'Pro Website', scope: 'zone' } },
        { state: 'Provisioned', rate_plan: { id: 'workers_paid', public_name: 'Workers Paid', scope: 'account', sets: ['workers'] } }
      ] }));
    });
    expect(cloudflare).toBe('workers-paid');

    const vercel = await detectVercelPlan('vercel-token', { ...defaultPlatformUsageSettings('vercel'), projectId: 'project-a' }, async (input) => {
      expect(String(input)).toContain('/v9/projects/project-a');
      return new Response(JSON.stringify({ plan: 'pro' }));
    });
    expect(vercel).toBe('pro');
  });

  it('treats an account without a Workers Paid subscription as Workers Free', async () => {
    await expect(detectCloudflarePlan('cf-token', 'account-id', async () => new Response(JSON.stringify({
      result: [{ state: 'Paid', rate_plan: { id: 'zone_pro', public_name: 'Pro Website', scope: 'zone' } }]
    })))).resolves.toBe('workers-free');
  });

  it('does not require billing access when the Cloudflare plan is selected manually', async () => {
    const { repository, notifications } = await setup();
    const requester = vi.fn(async () => new Response(JSON.stringify({ errors: [{ message: 'Forbidden' }] }), { status: 403 }));
    const monitor = new PlatformUsageMonitor(repository, notifications, 'cloudflare-workers', requester);
    const status = await monitor.configure({
      ...defaultPlatformUsageSettings('cloudflare-workers'),
      apiToken: 'cloudflare-secret-token',
      accountId: 'account-id',
      scriptName: 'walkie',
      plan: 'workers-paid'
    });

    expect(status.effectivePlan).toBe('workers-paid');
    expect(status.planDetectionError).toBeUndefined();
    expect(requester).not.toHaveBeenCalled();
  });

  it('encrypts the platform token and preserves it across DEK rotation', async () => {
    const { repository } = await setup();
    const token = 'cloudflare-secret-api-token';
    await repository.setPlatformUsageToken(token);
    const row = await repository.db.get("SELECT value FROM settings WHERE key='platform_usage_token'");
    expect(String(row?.value)).not.toContain(token);
    expect(await repository.getPlatformUsageToken()).toBe(token);

    await repository.rotateMasterKey();
    expect(await repository.getPlatformUsageToken()).toBe(token);
  });

  it('aggregates Vercel FOCUS JSONL by service and unit with project filtering', async () => {
    const settings = { ...defaultPlatformUsageSettings('vercel'), projectId: 'project-a' };
    const rows = [
      { ServiceName: 'Functions', ConsumedQuantity: 3, ConsumedUnit: 'invocations', BilledCost: 1, EffectiveCost: 0.5, Tags: { ProjectId: 'project-a' } },
      { ServiceName: 'Functions', ConsumedQuantity: 4, ConsumedUnit: 'invocations', BilledCost: 2, EffectiveCost: 1, Tags: { ProjectId: 'project-a' } },
      { ServiceName: 'Provisioned Memory', ConsumedQuantity: 8, ConsumedUnit: 'GB-hours', BilledCost: 0, EffectiveCost: 0, Tags: { ProjectId: 'project-a' } },
      { ServiceName: 'Functions', ConsumedQuantity: 99, ConsumedUnit: 'invocations', BilledCost: 9, EffectiveCost: 9, Tags: { ProjectId: 'project-b' } }
    ];
    const result = await fetchVercelUsage('vercel-token', settings, async (input, init) => {
      expect(new URL(String(input)).searchParams.get('from')).toBe('2026-08-01T00:00:00.000Z');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer vercel-token');
      return new Response(rows.map((row) => JSON.stringify(row)).join('\n'));
    }, new Date('2026-08-19T12:00:00.000Z'));

    expect(result.metrics.find((item) => item.key.startsWith('usage:Functions'))?.value).toBe(7);
    expect(result.metrics.find((item) => item.label === 'Provisioned Memory')).toMatchObject({ value: 8, limit: 360, period: 'month' });
    expect(result.metrics.find((item) => item.key === 'cost:billed')?.value).toBe(3);
    expect(result.periodKey).toBe('2026-08');
  });

  it('automatically collects Cloudflare Worker, Durable Object, and SQLite storage metrics', async () => {
    const settings = { ...defaultPlatformUsageSettings('cloudflare-workers'), accountId: 'account-id', scriptName: 'walkie' };
    const result = await fetchCloudflareUsage('cloudflare-token', settings, async (_input, init) => {
      const query = String((JSON.parse(String(init?.body)) as { query: string }).query);
      if (query.includes('workersInvocationsAdaptive')) return cloudflareResponse(42_000);
      if (query.includes('durableObjectsInvocationsAdaptiveGroups')) return new Response(JSON.stringify({
        data: { viewer: { accounts: [{ durableObjectsInvocationsAdaptiveGroups: [{ sum: { requests: 12_000, responseBodySize: 4096 } }] }] } }
      }));
      if (query.includes('durableObjectsSqlStorageGroups')) return new Response(JSON.stringify({
        data: { viewer: { accounts: [{ durableObjectsSqlStorageGroups: [{ max: { storedBytes: 123_456 } }] }] } }
      }));
      if (query.includes('durableObjectsPeriodicGroups')) return new Response(JSON.stringify({
        data: { viewer: { accounts: [{ durableObjectsPeriodicGroups: [{ sum: { cpuTime: 321 } }] }] } }
      }));
      throw new Error(`unexpected query: ${query}`);
    }, new Date('2026-08-19T12:00:00.000Z'));

    expect(result.metrics.find((item) => item.key === 'worker:requests')).toMatchObject({ value: 42_000, limit: 100_000, period: 'day' });
    expect(result.metrics.find((item) => item.key === 'durable-objects:requests')).toMatchObject({ value: 12_000, limit: 100_000, period: 'day' });
    expect(result.metrics.find((item) => item.key === 'durable-objects:sqlite-storage')).toMatchObject({ value: 123_456, limit: 1_000_000_000, period: 'current' });
    expect(result.metrics.find((item) => item.key === 'durable-objects:cpu-time')?.value).toBe(321);
  });

  it('keeps available Cloudflare metrics when an optional dataset is unavailable', async () => {
    const settings = { ...defaultPlatformUsageSettings('cloudflare-workers'), accountId: 'account-id', scriptName: 'walkie' };
    const result = await fetchCloudflareUsage('cloudflare-token', settings, async (_input, init) => {
      const query = String((JSON.parse(String(init?.body)) as { query: string }).query);
      if (query.includes('workersInvocationsAdaptive')) return cloudflareResponse(7);
      return new Response(JSON.stringify({ errors: [{ message: 'dataset unavailable' }] }), { status: 200 });
    });

    expect(result.metrics.find((item) => item.key === 'worker:requests')?.value).toBe(7);
    expect(result.warnings).toHaveLength(3);
  });

  it('normalizes legacy single-metric settings to the all-metric percentage policy', async () => {
    const { repository, notifications } = await setup();
    await repository.db.run("INSERT INTO settings (key,value,updated_at) VALUES ('platform_usage_settings',?,?)", [JSON.stringify({
      enabled: false, accountId: 'account-id', scriptName: 'walkie', teamId: '', projectId: '', metricKey: 'requests', threshold: 80_000, action: 'notify', destination: ''
    }), new Date().toISOString()]);

    const settings = (await new PlatformUsageMonitor(repository, notifications, 'cloudflare-workers').getStatus()).settings;
    expect(settings.warningPercent).toBe(80);
    expect(settings).not.toHaveProperty('metricKey');
    expect(settings).not.toHaveProperty('threshold');
  });

  it('alerts once, pauses every new notification, and supports manual re-enable', async () => {
    const { repository, notifications } = await setup();
    const channel = await repository.createChannel({
      name: 'Ops', slug: 'ops', provider: 'webhook',
      config: { url: 'https://hooks.example.com/x', method: 'POST', bodyTemplate: '{}' }
    });
    const monitor = new PlatformUsageMonitor(repository, notifications, 'cloudflare-workers', async () => cloudflareResponse(90_000));
    await monitor.configure({
      ...defaultPlatformUsageSettings('cloudflare-workers'), enabled: true, apiToken: 'cloudflare-secret-token',
      accountId: 'account-id', scriptName: 'walkie', warningPercent: 80,
      action: 'notify-and-disable', destination: channel.id
    });
    expect(JSON.stringify(await monitor.getStatus())).not.toContain('cloudflare-secret-token');

    await monitor.refresh();
    await monitor.refresh();
    expect((await repository.listDeliveries({ limit: 10 })).filter((item) => item.source === 'system:platform-usage')).toHaveLength(1);
    await expect(notifications.send({ destination: channel.id, title: 'blocked', body: 'x' }, 'test')).rejects.toThrow('平台用量保护已暂停');

    const enabled = await monitor.reenableDelivery();
    expect(enabled.deliveryDisabled).toBe(false);
    await expect(notifications.send({ destination: channel.id, title: 'allowed', body: 'x' }, 'test')).resolves.toBeTruthy();
  });

  it('records platform API failures without disabling delivery', async () => {
    const { repository, notifications } = await setup();
    const monitor = new PlatformUsageMonitor(repository, notifications, 'cloudflare-workers', async () => new Response(JSON.stringify({ errors: [{ message: 'forbidden' }] }), { status: 403 }));
    await monitor.configure({
      ...defaultPlatformUsageSettings('cloudflare-workers'), enabled: true, apiToken: 'cloudflare-secret-token',
      accountId: 'account-id', scriptName: 'walkie', warningPercent: 80, action: 'disable', destination: ''
    });

    await expect(monitor.refresh()).rejects.toThrow('forbidden');
    const status = await monitor.getStatus();
    expect(status.deliveryDisabled).toBe(false);
    expect(status.lastCheckedAt).toBeUndefined();
    expect(status.lastError).toContain('forbidden');
  });
});
