import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createNodeRepository } from '../src/server/database-node.js';
import { validateChannelCreate, validateChannelUpdate, validateRouteChannelIds, assertKeyDestinations } from '../src/server/validation.js';

const createRepository = () => createNodeRepository(':memory:', randomBytes(32));

describe('validation helpers', () => {
  it('validateChannelCreate rejects unknown provider and missing required fields', () => {
    expect(validateChannelCreate('no-such-provider', {})).toEqual(['不支持的渠道类型']);
    expect(validateChannelCreate('telegram', {})).toEqual(['Bot Token不能为空', 'Chat ID不能为空']);
    expect(validateChannelCreate('telegram', { botToken: 't', chatId: '42' })).toEqual([]);
    expect(validateChannelCreate('onebot', { server: 'https://qq.example.com' })).toContain('私聊 QQ 号或群号至少填写一项');
    expect(validateChannelCreate('wxpusher', { appToken: 'token' })).toContain('UID 列表或主题 ID 至少填写一项');
    expect(validateChannelCreate('apprise', { server: 'https://apprise.example.com' })).toContain('持久配置 Key 或 Apprise URL 至少填写一项');
    expect(validateChannelCreate('gotify', { server: 'not-a-url', token: 'token' })).toContain('服务地址必须是有效的 HTTP(S) 地址');
  });

  it('validateChannelUpdate merges config then revalidates required fields', async () => {
    const repository = await createRepository();
    await repository.createChannel({ name: 'Ops', slug: 'ops', provider: 'telegram', config: { botToken: 't', chatId: '42' } });
    const rename = await validateChannelUpdate(repository, 'ops', {});
    expect(rename.errors).toEqual([]);
    expect(rename.current?.name).toBe('Ops');
    const broken = await validateChannelUpdate(repository, 'ops', { config: { botToken: '' } });
    expect(broken.errors).toContain('Bot Token不能为空');
    const switchProvider = await validateChannelUpdate(repository, 'ops', { provider: 'slack', config: {} });
    expect(switchProvider.errors).toEqual(['Webhook 地址不能为空']);
    const switchWithTelegramConfig = await validateChannelUpdate(repository, 'ops', { provider: 'slack', config: { botToken: 't', chatId: '42' } });
    expect(switchWithTelegramConfig.errors).toEqual(['Webhook 地址不能为空']);
    repository.close();
  });

  it('validateRouteChannelIds flags unknown channel ids', async () => {
    const repository = await createRepository();
    const channel = await repository.createChannel({ name: 'Ops', slug: 'ops', provider: 'telegram', config: { botToken: 't', chatId: '42' } });
    expect(await validateRouteChannelIds(repository, [channel.id])).toEqual([]);
    expect(await validateRouteChannelIds(repository, [channel.id, 'no-such-id'])).toEqual(['路由包含不存在的频道']);
    repository.close();
  });

  it('assertKeyDestinations flags unknown destination ids', async () => {
    const repository = await createRepository();
    const channel = await repository.createChannel({ name: 'Ops', slug: 'ops', provider: 'telegram', config: { botToken: 't', chatId: '42' } });
    expect(await assertKeyDestinations(repository, [channel.id])).toEqual([]);
    expect(await assertKeyDestinations(repository, ['no-such-dest'])).toEqual(['目的地不存在：no-such-dest']);
    repository.close();
  });
});
