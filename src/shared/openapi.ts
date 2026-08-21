/** REST API 的 OpenAPI 3.1 描述（#14）。MCP 与兼容端点不在此列——它们各有自己的发现机制（tools/list 与 /api/meta） */
export function openApiSpec(publicUrl: string): Record<string, unknown> {
  const security = [{ bearerAuth: [] }];
  return {
    openapi: '3.1.0',
    info: {
      title: 'Walkie REST API',
      version: '1.0.0',
      description: 'Self-hosted notification control plane for AI agents. All agent endpoints authenticate with a Bearer Agent Key; admin endpoints use the admin password (Bearer or X-Admin-Token).'
    },
    servers: [{ url: publicUrl }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'Agent API Key (rdk_… or custom)' } },
      schemas: {
        Severity: { type: 'string', enum: ['info', 'success', 'warning', 'critical'] },
        Notification: {
          type: 'object',
          required: ['destination', 'title', 'body'],
          properties: {
            destination: { type: 'string', description: 'Destination ID or slug (channel / route)' },
            title: { type: 'string', maxLength: 200 },
            body: { type: 'string', maxLength: 20000 },
            severity: { $ref: '#/components/schemas/Severity' },
            url: { type: 'string', format: 'uri', description: 'http(s) only' },
            tags: { type: 'string', description: 'Pipe-separated tags' },
            short: { type: 'string', maxLength: 200, description: 'Short card summary for push channels' },
            idempotencyKey: { type: 'string', maxLength: 200, description: 'Same key returns the original delivery' },
            callbackUrl: { type: 'string', format: 'uri', description: 'Webhook receiving the final delivery result' },
            delaySeconds: { type: 'integer', minimum: 1, maximum: 157680000 },
            sendAt: { type: 'string', format: 'date-time' },
            repeatEverySeconds: { type: 'integer', minimum: 60, maximum: 31536000 },
            repeatCount: { type: 'integer', minimum: 2, maximum: 10000 }
          }
        },
        AskInput: {
          type: 'object',
          required: ['destination', 'question'],
          properties: {
            destination: { type: 'string' },
            question: { type: 'string', maxLength: 4000 },
            options: { type: 'array', items: { type: 'string', maxLength: 100 }, maxItems: 12 },
            title: { type: 'string', maxLength: 200 },
            severity: { $ref: '#/components/schemas/Severity' },
            timeoutSeconds: { type: 'integer', minimum: 30, maximum: 86400, default: 3600 }
          }
        },
        Error: { type: 'object', properties: { error: { type: 'string' } } }
      }
    },
    paths: {
      '/health': { get: { summary: 'Liveness probe', security: [], responses: { 200: { description: 'Service status' } } } },
      '/api/meta': { get: { summary: 'Instance metadata, compatibility endpoints, platform profile', security: [], responses: { 200: { description: 'Metadata' } } } },
      '/openapi.json': { get: { summary: 'This document', security: [], responses: { 200: { description: 'OpenAPI spec' } } } },
      '/api/v1/notify': {
        post: {
          summary: 'Send a notification (scope: notifications:send)',
          security,
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Notification' } } } },
          responses: {
            202: { description: 'Queued (or scheduled); returns deliveryId / scheduleId / status' },
            400: { description: 'Validation error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            401: { description: 'Invalid or revoked Agent Key' },
            403: { description: 'Key lacks notifications:send or destination not allowlisted' }
          }
        }
      },
      '/api/v1/ask': {
        post: {
          summary: 'Ask the human a question (scope: notifications:send)',
          description: 'Pushes the question with a one-time reply link; on Telegram channels options render as inline buttons.',
          security,
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/AskInput' } } } },
          responses: {
            201: { description: 'Conversation created; returns conversationId / replyUrl / expiresAt' },
            400: { description: 'Validation error' },
            401: { description: 'Invalid key' }
          }
        }
      },
      '/api/v1/conversations/{id}': {
        get: {
          summary: 'Conversation status (pending / replied / expired)',
          security,
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Status and reply when answered' }, 404: { description: 'Not found' } }
        }
      },
      '/api/v1/deliveries/{id}': {
        get: {
          summary: 'Delivery status with per-channel attempts (scope: deliveries:read)',
          security,
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Delivery detail' }, 404: { description: 'Not found' } }
        }
      },
      '/api/v1/schedules': { get: { summary: 'List own recurring schedules', security, responses: { 200: { description: 'Schedules' } } } },
      '/api/v1/schedules/{id}/cancel': {
        post: {
          summary: 'Cancel an own recurring schedule',
          security,
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: { 200: { description: 'Cancelled' }, 404: { description: 'Not found or not owned' } }
        }
      },
      '/reply/{id}/{token}': { get: { summary: 'One-time reply form (no auth; token in URL)', security: [], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'token', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Reply form HTML' }, 410: { description: 'Already replied or expired' } } } }
    }
  };
}
