import type { NotificationService } from './notifications.js';
import type { RelayRepository } from './database.js';
import { sendWithAgentKey } from './compat.js';

/**
 * Claude Code HTTP hook 接收端点（POST /api/v1/hooks/claude）。
 *
 * Claude Code v2.1+ 的 hook 支持 type: "http"——事件 JSON 直接 POST 过来，
 * 连脚本都不用写。这里把官方事件 schema（code.claude.com/docs/en/hooks）翻译成
 * Walkie 通知，按事件语义映射 severity：
 *
 *   Notification.permission_prompt / agent_needs_input / elicitation_*  → critical（在等你）
 *   Notification.idle_prompt                                            → info（60s 没动，提醒而已）
 *   Notification.agent_completed                                        → success（后台任务完成）
 *   Stop                                                                → success（本轮干完了）
 *   SubagentStop                                                        → info（子代理完成，太频繁不刷屏）
 *   StopFailure                                                         → critical（API 报错，回合中断）
 *   SessionEnd                                                          → 不通知（没有行动价值）
 *
 * 其余事件（PreToolUse 等）也接收但不发通知——那类事件每次工具调用都触发，
 * 发出来就是垃圾信息轰炸；端点统一回 2xx，避免 Claude Code 侧报 hook error。
 *
 * 目的地规则与兼容端点一致：Agent Key 只配一个目的地时自动用之；
 * key 绑了多个目的地时要求 URL 带 ?destination=<slug>（或为 hook 单独建一个 key）。
 */

interface HookInput {
  hook_event_name?: string;
  notification_type?: string;
  message?: string;
  title?: string;
  error?: string;
  error_details?: string;
  reason?: string;
  cwd?: string;
  last_assistant_message?: string;
  agent_type?: string;
  tool_name?: string;
}

/** cwd 取末两段做「哪个项目」的标识：完整路径又长又可能泄漏目录结构 */
function projectTag(cwd: string | undefined): string {
  if (!cwd) return '';
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts.slice(-2).join('/') : cwd;
}

/** 事件 → 通知的映射；返回 undefined 表示「收下但不发通知」 */
export function claudeHookToNotification(input: HookInput): {
  title: string;
  body: string;
  severity: 'info' | 'success' | 'warning' | 'critical';
  tags: string;
} | undefined {
  const project = projectTag(input.cwd);
  const where = project ? `（${project}）` : '';
  const event = input.hook_event_name ?? '';

  if (event === 'Notification') {
    const type = input.notification_type ?? '';
    if (type === 'permission_prompt' || type === 'agent_needs_input' || type.startsWith('elicitation_')) {
      // 等你操作：critical 配合 Web Push 的 requireInteraction + 长振动
      return { title: `Claude 需要你${where}`, body: (input.message || '等你授权或输入').slice(0, 2000), severity: 'critical', tags: 'claude-code|permission' };
    }
    if (type === 'agent_completed') {
      return { title: `Claude 后台任务完成${where}`, body: (input.message || input.title || '后台会话已结束').slice(0, 2000), severity: 'success', tags: 'claude-code' };
    }
    if (type === 'idle_prompt') {
      return { title: `Claude 在等你${where}`, body: (input.message || '回复已挂起 60 秒').slice(0, 2000), severity: 'info', tags: 'claude-code|idle' };
    }
    return undefined; // auth_success 等无行动价值
  }

  if (event === 'Stop') {
    const summary = (input.last_assistant_message ?? '').trim();
    // 摘要截前 600 字符：通知里够读就行，完整内容在会话里
    return { title: `Claude 完成了任务${where}`, body: summary ? summary.slice(0, 600) : '回合结束，等待下一步指令。', severity: 'success', tags: 'claude-code|stop' };
  }

  if (event === 'StopFailure') {
    return {
      title: `Claude 回合失败${where}`,
      body: `${input.error ?? 'unknown'}${input.error_details ? `：${input.error_details}` : ''}`.slice(0, 2000),
      severity: 'critical', tags: 'claude-code|error'
    };
  }

  if (event === 'SubagentStop') {
    return { title: `子代理完成（${input.agent_type ?? 'agent'}）${where}`, body: (input.last_assistant_message ?? '').trim().slice(0, 400) || '子代理回合结束。', severity: 'info', tags: 'claude-code|subagent' };
  }

  return undefined;
}

/** 处理 POST /api/v1/hooks/claude；返回给 Claude Code 的 JSON（2xx 即成功） */
export async function handleClaudeHook(
  repository: RelayRepository,
  notifications: NotificationService,
  body: unknown,
  token: string,
  destination: string | undefined,
  drain: () => void
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const input = (body && typeof body === 'object' ? body : {}) as HookInput;
  const mapped = claudeHookToNotification(input);
  if (!mapped) return { statusCode: 200, body: { ok: true, ignored: true, event: input.hook_event_name ?? null } };
  try {
    const delivery = await sendWithAgentKey(repository, notifications, token, { destination, ...mapped, metadata: { via: 'claude-hook' } }, 'claude-hook');
    drain();
    return { statusCode: 200, body: { ok: true, deliveryId: delivery.id } };
  } catch (error) {
    // 配置类错误（key 多目的地等）用 4xx 回给用户看；Claude Code 对非 2xx 只记 debug 不影响会话
    return { statusCode: 400, body: { ok: false, error: error instanceof Error ? error.message : String(error) } };
  }
}
