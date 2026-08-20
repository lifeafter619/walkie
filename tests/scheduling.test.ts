import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createNodeRepository } from '../src/server/database-node.js';
import type { RelayRepository } from '../src/server/database.js';
import { NotificationService } from '../src/server/notifications.js';

const repositories: RelayRepository[] = [];
afterEach(() => repositories.splice(0).forEach((repository) => repository.close()));

describe('notification scheduling', () => {
  it('queues delayed first delivery and materializes recurring runs', async () => {
    const repository = await createNodeRepository(':memory:', randomBytes(32));
    repositories.push(repository);
    const channel = await repository.createChannel({
      name: 'Ops', slug: 'ops', provider: 'webhook',
      config: { url: 'https://hooks.example.com/x', method: 'POST', bodyTemplate: '{}' }
    });
    const service = new NotificationService(repository);
    const delivery = await service.send({
      destination: channel.id, title: 'Scheduled', body: 'Body', delaySeconds: 120,
      repeatEverySeconds: 60, repeatCount: 2
    }, 'admin');

    expect(delivery.scheduleId).toBeTruthy();
    expect(new Date(delivery.scheduledAt!).getTime()).toBeGreaterThan(Date.now());
    expect(await repository.listSchedules()).toHaveLength(1);

    await repository.db.run('UPDATE schedules SET next_run_at=?', [new Date(Date.now() - 1000).toISOString()]);
    const materialized = await repository.materializeDueSchedules();
    expect(materialized.created).toHaveLength(1);
    expect(materialized.blocked).toBe(false);
    expect((await repository.listSchedules())[0]?.enabled).toBe(false);
  });

  it('cancels only the owning agent schedule', async () => {
    const repository = await createNodeRepository(':memory:', randomBytes(32));
    repositories.push(repository);
    const channel = await repository.createChannel({
      name: 'Ops', slug: 'ops', provider: 'webhook',
      config: { url: 'https://hooks.example.com/x', method: 'POST', bodyTemplate: '{}' }
    });
    const service = new NotificationService(repository);
    const delivery = await service.send({ destination: channel.id, title: 'A', body: 'B', repeatEverySeconds: 60 }, 'agent:key-a');
    await expect(repository.cancelSchedule(delivery.scheduleId!, 'agent:key-b', 'agent:key-b')).rejects.toThrow('周期任务不存在');
    await expect(repository.cancelSchedule(delivery.scheduleId!, 'agent:key-a', 'agent:key-a')).resolves.toMatchObject({ enabled: false });
  });

  it('does not materialize recurring deliveries past the usage limit', async () => {
    const repository = await createNodeRepository(':memory:', randomBytes(32));
    repositories.push(repository);
    const channel = await repository.createChannel({
      name: 'Ops', slug: 'ops', provider: 'webhook',
      config: { url: 'https://hooks.example.com/x', method: 'POST', bodyTemplate: '{}' }
    });
    await repository.setUsageSettings({ dailyDeliveryLimit: 1, monthlyDeliveryLimit: 0, warningPercent: 80 });
    const nextRunAt = new Date(Date.now() - 1000).toISOString();
    for (const title of ['First', 'Second']) {
      await repository.createSchedule({
        targetType: 'channel', targetId: channel.id, title, body: 'Body', severity: 'info',
        source: 'admin', intervalSeconds: 60, nextRunAt
      });
    }

    // 限额触发时第一条成功、第二条被阻塞：blocked=true 让 DO alarm 退避，next_run_at 原地不动
    const limited = await repository.materializeDueSchedules();
    expect(limited.created).toHaveLength(1);
    expect(limited.blocked).toBe(true);
    expect((await repository.listSchedules()).filter((schedule) => schedule.nextRunAt === nextRunAt)).toHaveLength(1);
  });
});
