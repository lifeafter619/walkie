import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ApiKey, ProviderId } from '../shared/types.js';
import { quietHoursSchema } from '../shared/schemas.js';
import type { RelayRepository } from './database.js';
import type { ProviderDispatcher } from './providers/dispatcher.js';
import { PROVIDERS } from './providers/catalog.js';
import { validateChannelCreate, validateChannelUpdate, validateRouteChannelIds } from './validation.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

const refSchema = z.string().min(1).describe('Channel or route ID or slug');
const testMessage = { title: 'Walkie 测试通知', body: '频道连接正常，可以接收 Agent 通知。', severity: 'success' as const, metadata: {} };

/** config:write 工具集：渠道与路由的查看/创建/更新/删除/测试。不包含任何 Key 管理能力。 */
export function registerConfigTools(server: McpServer, repository: RelayRepository, dispatcher: ProviderDispatcher, apiKey: ApiKey): void {
  const actor = `agent:${apiKey.id}`;
  const throwErrors = (errors: string[]) => { if (errors.length) throw new Error(errors.join('；')); };

  server.registerTool('list_channel_types', {
    title: 'List channel types',
    description: 'List all supported channel types with their config field definitions (labels, required flags, options). Use this to learn which values to ask the user for before create_channel.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true }
  }, async () => result({ channelTypes: PROVIDERS }));

  server.registerTool('list_channels', {
    title: 'List channels',
    description: 'List all channels (including disabled) with provider, slug and config key names. Config values are never returned.',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true }
  }, async () => result({ channels: await repository.listChannels() }));

  server.registerTool('create_channel', {
    title: 'Create a channel',
    description: 'Create a notification channel. Call list_channel_types first for required fields of the provider.',
    inputSchema: z.object({
      name: z.string().min(1).max(100),
      slug: z.string().min(2).max(80).regex(/^[a-z0-9][a-z0-9-]*$/),
      provider: z.string().min(1),
      config: z.record(z.string(), z.unknown()),
      enabled: z.boolean().optional(),
      rateLimitPerMin: z.number().int().min(0).max(600).nullish(),
      quietHours: quietHoursSchema,
      maxAttempts: z.number().int().min(0).max(10).optional()
    }),
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: false }
  }, async (input) => {
    throwErrors(validateChannelCreate(input.provider, input.config));
    const channel = await repository.createChannel({ ...input, provider: input.provider as ProviderId }, actor);
    return result({ channel });
  });

  server.registerTool('update_channel', {
    title: 'Update a channel',
    description: 'Update an existing channel by ID or slug. Config merges over the stored values; required fields are revalidated after merge.',
    inputSchema: z.object({
      channel: refSchema,
      name: z.string().min(1).max(100).optional(),
      slug: z.string().min(2).max(80).regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
      provider: z.string().min(1).optional(),
      config: z.record(z.string(), z.unknown()).optional(),
      enabled: z.boolean().optional(),
      rateLimitPerMin: z.number().int().min(0).max(600).nullish(),
      quietHours: quietHoursSchema,
      maxAttempts: z.number().int().min(0).max(10).optional()
    }),
    annotations: { destructiveHint: false, openWorldHint: false }
  }, async ({ channel: ref, provider, config, ...rest }) => {
    const { current, errors } = await validateChannelUpdate(repository, ref, { provider, config });
    if (!current) throw new Error('频道不存在');
    throwErrors(errors);
    const updated = await repository.updateChannel(current.id, { ...rest, ...(provider ? { provider: provider as ProviderId } : {}), ...(config ? { config } : {}) }, actor);
    return result({ channel: updated });
  });

  server.registerTool('delete_channel', {
    title: 'Delete a channel',
    description: 'Delete a channel by ID or slug. If referenced by routes or past deliveries it is disabled instead of removed.',
    inputSchema: z.object({ channel: refSchema }),
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ channel: ref }) => {
    const current = await repository.getChannel(ref);
    if (!current) throw new Error('频道不存在');
    await repository.deleteChannel(current.id, actor);
    return result({ deleted: true, id: current.id, slug: current.slug });
  });

  server.registerTool('test_channel', {
    title: 'Test a channel',
    description: 'Send a test notification through a channel and report success or the provider error. Use after create/update to verify credentials.',
    inputSchema: z.object({ channel: refSchema }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
  }, async ({ channel: ref }) => {
    const channel = await repository.getChannel(ref);
    if (!channel) throw new Error('频道不存在');
    try {
      await dispatcher.send(channel.provider, await repository.getChannelConfig(channel.id), { ...testMessage });
      await repository.setChannelTest(channel.id, true);
      return result({ success: true, channel: channel.slug });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await repository.setChannelTest(channel.id, false, message);
      return result({ success: false, error: message, channel: channel.slug });
    }
  });

  server.registerTool('create_route', {
    title: 'Create a route',
    description: 'Create a route (fanout sends to all channels; fallback tries channels in order until one succeeds).',
    inputSchema: z.object({
      name: z.string().min(1).max(100),
      slug: z.string().min(2).max(80).regex(/^[a-z0-9][a-z0-9-]*$/),
      strategy: z.enum(['fanout', 'fallback']),
      channelIds: z.array(z.string().min(1)).min(1),
      enabled: z.boolean().optional()
    }),
    annotations: { destructiveHint: false, openWorldHint: false }
  }, async (input) => {
    throwErrors(await validateRouteChannelIds(repository, input.channelIds));
    const route = await repository.createRoute(input, actor);
    return result({ route });
  });

  server.registerTool('update_route', {
    title: 'Update a route',
    description: 'Update a route by ID or slug.',
    inputSchema: z.object({
      route: refSchema,
      name: z.string().min(1).max(100).optional(),
      slug: z.string().min(2).max(80).regex(/^[a-z0-9][a-z0-9-]*$/).optional(),
      strategy: z.enum(['fanout', 'fallback']).optional(),
      channelIds: z.array(z.string().min(1)).min(1).optional(),
      enabled: z.boolean().optional()
    }),
    annotations: { destructiveHint: false, openWorldHint: false }
  }, async ({ route: ref, ...input }) => {
    const current = await repository.getRoute(ref);
    if (!current) throw new Error('路由不存在');
    if (input.channelIds) throwErrors(await validateRouteChannelIds(repository, input.channelIds));
    const route = await repository.updateRoute(current.id, input, actor);
    return result({ route });
  });

  server.registerTool('delete_route', {
    title: 'Delete a route',
    description: 'Delete a route by ID or slug. Soft-disables it first if active deliveries depend on it.',
    inputSchema: z.object({ route: refSchema }),
    annotations: { destructiveHint: true, idempotentHint: true, openWorldHint: false }
  }, async ({ route: ref }) => {
    const current = await repository.getRoute(ref);
    if (!current) throw new Error('路由不存在');
    await repository.deleteRoute(current.id, actor);
    return result({ deleted: true, id: current.id, slug: current.slug });
  });
}
