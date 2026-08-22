/** REST API 的 OpenAPI 3.1 描述（#14）。MCP 与兼容端点不在此列——它们各有自己的发现机制（tools/list 与 /api/meta） */
export function openApiSpec(publicUrl: string): Record<string, unknown> {
  const security = [{ bearerAuth: [] }];
  const admin = [{ adminAuth: [] }];
  const idParam = [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }];
  return {
    openapi: '3.1.0',
    info: {
      title: 'Walkie REST API',
      version: '1.0.0',
      description: 'Self-hosted notification control plane for AI agents. All agent endpoints authenticate with a Bearer Agent Key; admin endpoints use the admin password (Bearer or X-Admin-Token).'
    },
    servers: [{ url: publicUrl }],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', description: 'Agent API Key (rdk_… or custom)' },
        adminAuth: { type: 'http', scheme: 'bearer', description: 'Admin password (also accepted as the X-Admin-Token header)' }
      },
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
      '/api/v1/hooks/agent': {
        post: {
          summary: 'Coding-agent hook receiver (Claude Code / Cursor / Codex / Qwen Code / Gemini CLI / Droid / ZCode / opencode)',
          description: 'POST agent hook event JSON here — Claude Code natively via type:"http" hooks, other tools via the walkie-notify forwarding script. Events are normalized (camelCase names, Codex notify type, Gemini AfterAgent) and translated into notifications: permission waits and hard failures → critical, tool failures → warning, task completion → success, idle hints → info; no-op events (SessionEnd, PreToolUse…) are acknowledged with ignored:true. min_severity drops events below the chosen level (the user or agent picks what deserves a ping); filtered:true in the response means it was dropped by that rule. The key must target exactly one destination, or pass ?destination=<slug>.',
          security,
          parameters: [
            { name: 'destination', in: 'query', required: false, schema: { type: 'string' }, description: 'Destination slug, required when the key has multiple destinations' },
            { name: 'min_severity', in: 'query', required: false, schema: { type: 'string', enum: ['info', 'success', 'warning', 'critical'] }, description: 'Minimum severity to actually notify; lower-severity events are acknowledged with filtered:true' }
          ],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { hook_event_name: { type: 'string', description: 'Notification | Stop | StopFailure | SubagentStop | stop | sessionEnd | AfterAgent | … (case-insensitive first letter)' }, type: { type: 'string', description: 'Codex notify events, e.g. agent-turn-complete' }, message: { type: 'string' }, notification_type: { type: 'string' }, last_assistant_message: { type: 'string' }, status: { type: 'string', description: 'Cursor stop: completed | error | aborted' }, reason: { type: 'string', description: 'sessionEnd reason; error → critical' }, cwd: { type: 'string' } } } } } },
          responses: { 200: { description: '{ ok, deliveryId?, ignored?, filtered? }' }, 400: { description: 'Key has multiple destinations and none was specified' }, 401: { description: 'Invalid agent key' } }
        }
      },
      '/api/v1/hooks/claude': {
        post: {
          summary: 'Alias of /api/v1/hooks/agent (early name)',
          security,
          responses: { 200: { description: 'Same as /api/v1/hooks/agent' } }
        }
      },
      '/reply/{id}/{token}': { get: { summary: 'One-time reply form (no auth; token in URL)', security: [], parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }, { name: 'token', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Reply form HTML' }, 410: { description: 'Already replied or expired' } } } },

      // ---- 管理面（控制台用；鉴权是管理密码，不是 Agent Key）----
      '/api/admin/channels': {
        get: { summary: 'List channels', tags: ['admin'], security: admin, responses: { 200: { description: 'Channels; credentials are never returned, only configKeys' } } },
        post: { summary: 'Create a channel', tags: ['admin'], security: admin, responses: { 201: { description: 'Created' }, 400: { description: 'Missing required provider fields' } } }
      },
      '/api/admin/channels/{id}': {
        patch: { summary: 'Update a channel (config merges over stored values)', tags: ['admin'], security: admin, parameters: idParam, responses: { 200: { description: 'Updated' }, 404: { description: 'Not found' } } },
        delete: {
          summary: 'Delete a channel',
          description: 'Soft-disables instead when the channel has delivery history or is referenced by a route. Pass ?purge=1 to delete it together with its attempt history.',
          tags: ['admin'], security: admin,
          parameters: [...idParam, { name: 'purge', in: 'query', schema: { type: 'string', enum: ['1'] }, description: 'Also delete this channel\'s delivery history' }],
          responses: { 200: { description: '{ removed, disabled, purgedAttempts }' } }
        }
      },
      '/api/admin/channels/{id}/test': { post: { summary: 'Send a test notification through a channel', tags: ['admin'], security: admin, parameters: idParam, responses: { 200: { description: 'Delivered' }, 502: { description: 'Provider rejected it; body carries the error' } } } },
      '/api/admin/routes': {
        get: { summary: 'List routes', tags: ['admin'], security: admin, responses: { 200: { description: 'Routes' } } },
        post: { summary: 'Create a route (fanout or fallback)', tags: ['admin'], security: admin, responses: { 201: { description: 'Created' } } }
      },
      '/api/admin/keys': {
        get: { summary: 'List Agent Keys', tags: ['admin'], security: admin, responses: { 200: { description: 'Keys' } } },
        post: { summary: 'Create an Agent Key (custom secret allowed)', tags: ['admin'], security: admin, responses: { 201: { description: 'Key; the plaintext secret is returned here' } } }
      },
      '/api/admin/deliveries': { get: { summary: 'List deliveries (status filter, full-text q, cursor paging via before)', tags: ['admin'], security: admin, responses: { 200: { description: 'Deliveries' } } } },
      '/api/admin/conversations': { get: { summary: 'List ask_user conversations', tags: ['admin'], security: admin, responses: { 200: { description: 'Conversations' } } } },
      '/api/admin/conversations/{id}/reply': { post: { summary: 'Answer a pending conversation from the console', tags: ['admin'], security: admin, parameters: idParam, responses: { 200: { description: 'Recorded' }, 409: { description: 'Already replied or expired' } } } },
      '/api/admin/inbox': {
        get: { summary: 'List messages sent to the agent (pending=1 for unclaimed only)', tags: ['admin'], security: admin, responses: { 200: { description: 'Inbox messages' } } },
        post: { summary: 'Send a message to the agent; collected by the MCP wait_for_inbox tool', tags: ['admin'], security: admin, responses: { 201: { description: 'Queued' } } }
      },
      '/api/admin/webpush': { get: { summary: 'VAPID public key and current subscriptions (key is generated on first call)', tags: ['admin'], security: admin, responses: { 200: { description: 'Web Push state' } } } },
      '/api/admin/webpush/subscribe': {
        post: { summary: 'Register a browser push subscription', tags: ['admin'], security: admin, responses: { 201: { description: 'Stored' }, 400: { description: 'endpoint must be HTTPS and keys must be present' } } },
        delete: { summary: 'Remove a subscription by ?endpoint=', tags: ['admin'], security: admin, responses: { 200: { description: 'Removed' }, 404: { description: 'Unknown endpoint' } } }
      },
      '/api/admin/retention': { get: { summary: 'Read retention policy', tags: ['admin'], security: admin, responses: { 200: { description: 'Days per table; 0 = keep forever' } } }, put: { summary: 'Update retention policy', tags: ['admin'], security: admin, responses: { 200: { description: 'Saved' } } } },
      '/api/admin/audit': { get: { summary: 'Audit log (actor/action prefix filters)', tags: ['admin'], security: admin, responses: { 200: { description: 'Events' } } } },

      // ---- 平台回调（鉴权是各平台自己的签名/密钥，不用 Walkie 的凭据）----
      '/telegram/webhook/{secret}': { post: { summary: 'Telegram Bot webhook: button callbacks, free-text replies and inbox', description: 'Secret is derived from the bot token and shown on the channel edit form; also send it as X-Telegram-Bot-Api-Secret-Token.', security: [], parameters: [{ name: 'secret', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Handled' }, 401: { description: 'Unknown secret' } } } },
      '/slack/interactive/{secret}': { post: { summary: 'Slack Block Kit button callbacks', description: 'Verified with X-Slack-Signature when the channel has a signing secret; otherwise the URL secret is the credential.', security: [], parameters: [{ name: 'secret', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Handled' }, 401: { description: 'Bad signature' } } } },
      '/slack/events/{secret}': { post: { summary: 'Slack Events API: free-text replies and inbox', security: [], parameters: [{ name: 'secret', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'Handled or url_verification challenge' }, 401: { description: 'Bad signature' } } } },
      '/discord/interactions/{secret}': { post: { summary: 'Discord Interactions: button callbacks', description: 'Always verified with Ed25519 against the application public key — Discord probes with a bad signature before saving the endpoint.', security: [], parameters: [{ name: 'secret', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: { description: 'PONG or interaction response' }, 401: { description: 'Bad signature' } } } }
    }
  };
}
