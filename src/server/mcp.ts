import { McpServer, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ApiKey } from '../shared/types.js';
import type { RelayRepository } from './database.js';
import type { NotificationService } from './notifications.js';

const result = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  structuredContent: value as Record<string, unknown>
});

export function createRelayMcpServer(repository: RelayRepository, notifications: NotificationService, apiKey: ApiKey): McpServer {
  const server = new McpServer(
    { name: 'RelayDock', version: '0.1.0' },
    { supportedProtocolVersions: ['2026-07-28', ...SUPPORTED_PROTOCOL_VERSIONS] }
  );

  server.registerTool('list_destinations', {
    title: 'List notification destinations',
    description: 'List enabled channels and routes this Agent is allowed to use.',
    inputSchema: z.object({})
  }, async () => result({ destinations: notifications.listDestinations(apiKey) }));

  server.registerTool('list_routes', {
    title: 'List notification routes',
    description: 'List enabled fanout and fallback routes this Agent can use.',
    inputSchema: z.object({})
  }, async () => {
    const allowed = new Set(notifications.listDestinations(apiKey).filter((item) => item.kind === 'route').map((item) => item.id));
    return result({ routes: repository.listRoutes().filter((route) => route.enabled && allowed.has(route.id)) });
  });

  server.registerTool('send_notification', {
    title: 'Send notification',
    description: 'Queue a notification to an allowed channel or route. Returns a delivery ID for status tracking.',
    inputSchema: z.object({
      destination: z.string().min(1).describe('Destination ID or slug from list_destinations'),
      title: z.string().min(1).max(200),
      body: z.string().min(1).max(20_000),
      severity: z.enum(['info', 'success', 'warning', 'critical']).default('info'),
      url: z.url().optional(),
      tags: z.string().max(200).optional().describe('Pipe-separated tags, forwarded to channels that support them'),
      short: z.string().max(200).optional().describe('Short card summary for push channels'),
      metadata: z.record(z.string(), z.unknown()).optional(),
      idempotencyKey: z.string().min(1).max(200).optional()
    }),
    annotations: { destructiveHint: false, idempotentHint: false, openWorldHint: true }
  }, async (input) => {
    const delivery = notifications.send(input, `agent:${apiKey.id}`, apiKey);
    return result({ deliveryId: delivery.id, status: delivery.status, createdAt: delivery.createdAt });
  });

  server.registerTool('get_delivery', {
    title: 'Get delivery status',
    description: 'Return aggregate and per-channel status for a queued notification.',
    inputSchema: z.object({ deliveryId: z.string().uuid() }),
    annotations: { readOnlyHint: true }
  }, async ({ deliveryId }) => result({ delivery: notifications.getDelivery(deliveryId, apiKey) }));

  return server;
}
