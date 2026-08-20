import { createMcpHandler, McpServer, SUPPORTED_PROTOCOL_VERSIONS, type McpRequestContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ApiKey } from '../shared/types.js';
import { VERSION } from '../shared/version.js';
import { safeLinkSchema } from '../shared/schemas.js';
import type { RelayRepository } from './database.js';
import { registerConfigTools } from './mcp-config.js';
import type { NotificationService } from './notifications.js';
import type { ProviderDispatcher } from './providers/dispatcher.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function createRelayMcpServer(repository: RelayRepository, notifications: NotificationService, dispatcher: ProviderDispatcher, apiKey: ApiKey, publicUrl = ''): McpServer {
  const server = new McpServer(
    { name: 'Walkie', version: VERSION },
    {
      supportedProtocolVersions: ['2026-07-28', ...SUPPORTED_PROTOCOL_VERSIONS],
      instructions: 'Use list_destinations before sending. Call send_notification with an allowed destination slug or ID, then use get_delivery with the returned deliveryId when delivery status is needed. To ask the human a question, call ask_user, then poll check_reply with the returned conversationId until status is replied or the deadline passes. Never invent destination IDs.'
        + (apiKey.scopes.includes('config:write')
          ? ' When the user asks to set up or change notification channels or routes: call list_channel_types to learn the provider\'s required fields, ask the user for any missing required values, then create_channel, test_channel, and report the result. Never echo config values back to the user or logs.'
          : '')
    }
  );

  server.registerTool('list_destinations', {
    title: 'List notification destinations',
    description: 'List enabled channels and routes this Agent is allowed to use.',
    inputSchema: z.object({})
  }, async () => result({ destinations: await notifications.listDestinations(apiKey) }));

  server.registerTool('list_routes', {
    title: 'List notification routes',
    description: 'List routes this Agent can use (all routes when the key has config:write).',
    inputSchema: z.object({})
  }, async () => {
    if (apiKey.scopes.includes('config:write')) return result({ routes: await repository.listRoutes() });
    const allowed = new Set((await notifications.listDestinations(apiKey)).filter((item) => item.kind === 'route').map((item) => item.id));
    return result({ routes: (await repository.listRoutes()).filter((route) => route.enabled && allowed.has(route.id)) });
  });

  if (apiKey.scopes.includes('notifications:send')) server.registerTool('send_notification', {
    title: 'Send notification',
    description: 'Queue a notification to an allowed channel or route. Returns a delivery ID for status tracking.',
    inputSchema: z.object({
      destination: z.string().min(1).describe('Destination ID or slug from list_destinations'),
      title: z.string().min(1).max(200),
      body: z.string().min(1).max(20_000),
      severity: z.enum(['info', 'success', 'warning', 'critical']).default('info'),
      url: safeLinkSchema.optional(),
      tags: z.string().max(200).optional().describe('Pipe-separated tags, forwarded to channels that support them'),
      short: z.string().max(200).optional().describe('Short card summary for push channels'),
      metadata: z.record(z.string(), z.unknown()).optional(),
      idempotencyKey: z.string().min(1).max(200).optional(),
      callbackUrl: safeLinkSchema.optional().describe('Optional webhook that receives the final delivery result'),
      delaySeconds: z.number().int().min(1).max(157_680_000).optional(),
      sendAt: z.string().datetime({ offset: true }).optional(),
      repeatEverySeconds: z.number().int().min(60).max(31_536_000).optional(),
      repeatCount: z.number().int().min(2).max(10_000).optional()
    }),
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async (input) => {
    const delivery = await notifications.send(input, `agent:${apiKey.id}`, apiKey);
    return result({ deliveryId: delivery.id, scheduleId: delivery.scheduleId, status: delivery.status, scheduledAt: delivery.scheduledAt, createdAt: delivery.createdAt });
  });

  if (apiKey.scopes.includes('notifications:send')) server.registerTool('list_schedules', {
    title: 'List recurring schedules',
    description: 'List recurring schedules owned by this Agent Key.',
    inputSchema: z.object({})
  }, async () => result({ schedules: await repository.listSchedules({ source: `agent:${apiKey.id}` }) }));

  if (apiKey.scopes.includes('notifications:send')) server.registerTool('cancel_schedule', {
    title: 'Cancel recurring schedule',
    description: 'Disable a recurring schedule owned by this Agent Key.',
    inputSchema: z.object({ scheduleId: z.string().uuid() }),
    annotations: { destructiveHint: true, openWorldHint: true }
  }, async ({ scheduleId }) => result({ schedule: await repository.cancelSchedule(scheduleId, `agent:${apiKey.id}`, `agent:${apiKey.id}`) }));

  if (apiKey.scopes.includes('notifications:send')) server.registerTool('ask_user', {
    title: 'Ask the human a question',
    description: 'Push a question to the human through an allowed destination and get a conversationId. The human replies from any device via a one-time link; poll check_reply to collect the answer.',
    inputSchema: z.object({
      destination: z.string().min(1).describe('Destination ID or slug from list_destinations'),
      question: z.string().min(1).max(4000),
      options: z.array(z.string().min(1).max(100)).max(12).optional().describe('Preset choices rendered as buttons; the human can still type a free-form answer'),
      title: z.string().max(200).optional(),
      severity: z.enum(['info', 'success', 'warning', 'critical']).default('warning'),
      timeoutSeconds: z.number().int().min(30).max(86_400).default(3600).describe('How long the reply link stays valid')
    }),
    annotations: { destructiveHint: false, openWorldHint: true }
  }, async (input) => {
    const asked = await notifications.ask(input, `agent:${apiKey.id}`, apiKey, publicUrl);
    return result({ conversationId: asked.conversation.id, deliveryId: asked.deliveryId, expiresAt: asked.conversation.expiresAt });
  });

  if (apiKey.scopes.includes('notifications:send')) server.registerTool('check_reply', {
    title: 'Check for a human reply',
    description: 'Long-poll a conversation created by ask_user. Waits up to waitSeconds server-side; returns status pending, replied, or expired. Keep calling while pending.',
    inputSchema: z.object({
      conversationId: z.string().uuid(),
      waitSeconds: z.number().int().min(0).max(25).default(20)
    }),
    annotations: { readOnlyHint: true }
  }, async ({ conversationId, waitSeconds }) => {
    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      const { status, conversation } = await notifications.conversationStatus(conversationId, apiKey);
      if (status !== 'pending' || Date.now() >= deadline) {
        return result({ status, reply: conversation.reply, repliedAt: conversation.repliedAt, expiresAt: conversation.expiresAt });
      }
      await sleep(1000);
    }
  });

  if (apiKey.scopes.includes('deliveries:read')) server.registerTool('get_delivery', {
    title: 'Get delivery status',
    description: 'Return aggregate and per-channel status for a queued notification.',
    inputSchema: z.object({ deliveryId: z.string().uuid() }),
    annotations: { readOnlyHint: true }
  }, async ({ deliveryId }) => result({ delivery: await notifications.getDelivery(deliveryId, apiKey) }));

  if (apiKey.scopes.includes('config:write')) registerConfigTools(server, repository, dispatcher, apiKey);

  return server;
}

export function createRelayMcpHandler(repository: RelayRepository, notifications: NotificationService, dispatcher: ProviderDispatcher, publicUrl: (request?: Request) => string = () => '') {
  return createMcpHandler(async ({ authInfo, requestInfo }: McpRequestContext) => {
    const apiKey = authInfo?.clientId ? await repository.getKey(authInfo.clientId) : undefined;
    if (!apiKey || apiKey.revokedAt) throw new Error('无效或已吊销的 Agent API Key');
    return createRelayMcpServer(repository, notifications, dispatcher, apiKey, publicUrl(requestInfo));
  }, {
    legacy: 'stateless',
    responseMode: 'json',
    onerror: (error) => console.error(JSON.stringify({ event: 'mcp.error', message: error.message }))
  });
}
