import type { NotificationService } from './notifications.js';
import type { RelayRepository } from './database.js';
import { sendWithAgentKey } from './compat.js';

/**
 * 编码 Agent HTTP hook 接收端点（POST /api/v1/hooks/agent）。
 *
 * 一个端点接所有工具：Claude Code（原生 http hook）、Codex / Qwen Code / Gemini CLI /
 * Droid / ZCode / Cursor（command hook 转发脚本 POST 过来）、opencode（生成的插件）。
 * 各家事件 schema 高度同构，服务端统一归一化后按语义映射 severity：
 *
 *   等你操作类（permission_prompt / agent_needs_input / elicitation_* / PermissionRequest /
 *     Gemini·Qwen·Droid 的 Notification）
 *     与失败类（StopFailure / Cursor stop.status=error / sessionEnd.reason=error）
 *     → critical
 *   任务完成类（Stop / agent_completed / Codex agent-turn-complete / Gemini AfterAgent）
 *     → success
 *   轻提示类（idle_prompt / SubagentStop）→ info
 *   高频无行动价值类（SessionEnd / PreToolUse / auth_success）→ 不发
 *
 * 通知条件由安装时选定、编码进 URL 查询参数（用户与 Agent 都能改）：
 *   ?min_severity=<info|success|warning|critical>   低于该级别的事件收下但不发
 *   ?destination=<slug>                              key 绑多目的地时指定
 * 脚本/配置里看不到密钥明文（经 $WALKIE_TOKEN 插值或转发脚本读环境变量）。
 */

interface HookInput {
  hook_event_name?: string;
  notification_type?: string;
  message?: string;
  title?: string;
  error?: string;
  error_details?: string;
  error_message?: string;
  reason?: string;
  status?: string;
  cwd?: string;
  workspace_roots?: unknown;
  last_assistant_message?: string;
  'last-assistant-message'?: string;
  input_messages?: unknown;
  'input-messages'?: unknown;
  agent_type?: string;
  tool_name?: string;
  cursor_version?: string;
  type?: string;
}

const SEVERITY_ORDER = { info: 0, success: 1, warning: 2, critical: 3 } as const;
type Severity = keyof typeof SEVERITY_ORDER;

export function parseMinSeverity(value: string | undefined): Severity | undefined {
  return value && value in SEVERITY_ORDER ? value as Severity : undefined;
}

/** cwd 取末两段做「哪个项目」的标识：完整路径又长又可能泄漏目录结构 */
function projectTag(cwd: string | undefined): string {
  if (!cwd) return '';
  const parts = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  return parts.length ? parts.slice(-2).join('/') : cwd;
}

/**
 * 事件名归一化：Cursor 用小驼峰（stop / postToolUseFailure / sessionEnd），
 * Gemini 用 BeforeAgent/AfterAgent，Codex notify 用 type=agent-turn-complete。
 * 统一成句点大驼峰再走映射——一套翻译管五家。
 */
function normalizeEvent(input: HookInput): string {
  if (input.hook_event_name) return input.hook_event_name.slice(0, 1).toUpperCase() + input.hook_event_name.slice(1);
  if (input.type === 'agent-turn-complete') return 'Stop'; // Codex notify 的唯一事件
  if (input.type) return input.type.slice(0, 1).toUpperCase() + input.type.slice(1);
  return '';
}

const lastMessage = (input: HookInput): string =>
  (input.last_assistant_message ?? input['last-assistant-message'] ?? input.message ?? input.error_message ?? '').trim();

/** hook 载沙是各家工具随手 POST 的 JSON，字段类型不可信——统一收窄成 string，畸形类型不能把端点打成 500 */
function coerceHookInput(rawInput: HookInput): HookInput {
  const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
  return {
    ...rawInput,
    hook_event_name: str(rawInput.hook_event_name),
    type: str(rawInput.type),
    notification_type: str(rawInput.notification_type),
    message: str(rawInput.message),
    title: str(rawInput.title),
    error: str(rawInput.error),
    error_details: str(rawInput.error_details),
    error_message: str(rawInput.error_message),
    reason: str(rawInput.reason),
    status: str(rawInput.status),
    cwd: str(rawInput.cwd),
    last_assistant_message: str(rawInput.last_assistant_message),
    'last-assistant-message': str(rawInput['last-assistant-message']),
    tool_name: str(rawInput.tool_name),
    agent_type: str(rawInput.agent_type)
  };
}

/** 事件 → 通知的映射；返回 undefined 表示「收下但不发通知」 */
export function claudeHookToNotification(rawInput: HookInput): {
  title: string;
  body: string;
  severity: Severity;
  tags: string;
} | undefined {
  const input = coerceHookInput(rawInput);
  // Cursor 的事件没有 cwd，项目标识在 workspace_roots 里
  const roots = Array.isArray(input.workspace_roots) ? input.workspace_roots : [];
  const project = projectTag(input.cwd ?? (typeof roots[0] === 'string' ? roots[0] : undefined));
  const where = project ? `（${project}）` : '';
  const event = normalizeEvent(input);

  if (event === 'Notification') {
    const type = input.notification_type ?? input.message ?? '';
    if (type === 'permission_prompt' || type === 'agent_needs_input' || type.startsWith('elicitation_')) {
      // 等你操作：critical 配合 Web Push 的 requireInteraction + 长振动
      return { title: `Agent 需要你${where}`, body: (input.message || input.title || '等你授权或输入').slice(0, 2000), severity: 'critical', tags: 'agent-hook|permission' };
    }
    if (type === 'agent_completed') {
      return { title: `后台任务完成${where}`, body: (input.message || input.title || '后台会话已结束').slice(0, 2000), severity: 'success', tags: 'agent-hook' };
    }
    if (type === 'idle_prompt') {
      return { title: `Agent 在等你${where}`, body: (input.message || '回复已挂起 60 秒').slice(0, 2000), severity: 'info', tags: 'agent-hook|idle' };
    }
    // Gemini / Qwen / Droid 的 Notification 没有 notification_type，语义就是「要你看一眼」
    // （Droid：需要授权或输入已空闲 60 秒）——按等你操作处理
    if (!input.notification_type && (input.message || input.title)) {
      return { title: `Agent 需要你${where}`, body: (input.message || input.title || '').slice(0, 2000), severity: 'critical', tags: 'agent-hook|permission' };
    }
    return undefined; // auth_success 等无行动价值
  }

  // Codex / Qwen / ZCode：Agent 在等你批准某次工具调用。转发脚本不产出 stdout，
  // 所以不影响它们各自的审批流程（无 decision = 走正常提示）
  if (event === 'PermissionRequest') {
    return {
      title: `Agent 等你批准${where}`,
      body: `${input.tool_name ?? '工具调用'} 等待授权`.slice(0, 2000),
      severity: 'critical', tags: 'agent-hook|permission'
    };
  }

  if (event === 'Stop') {
    // Cursor 的 stop 事件带 status（completed|error|aborted）；错误回合要按 critical 告警
    if (input.status === 'error') {
      return { title: `回合失败${where}`, body: (lastMessage(input) || '回合以错误结束').slice(0, 2000), severity: 'critical', tags: 'agent-hook|error' };
    }
    if (input.status === 'aborted') return undefined; // 用户主动打断，无行动价值
    const summary = lastMessage(input);
    // 摘要截前 600 字符：通知里够读就行，完整内容在会话里
    return { title: `Agent 完成了任务${where}`, body: summary ? summary.slice(0, 600) : '回合结束，等待下一步指令。', severity: 'success', tags: 'agent-hook|stop' };
  }

  // Gemini CLI：agent 循环结束（AfterAgent）
  if (event === 'AfterAgent') {
    const summary = lastMessage(input);
    return { title: `Agent 完成了任务${where}`, body: summary ? summary.slice(0, 600) : '回合结束。', severity: 'success', tags: 'agent-hook|stop' };
  }

  if (event === 'PostToolUseFailure') {
    // Claude Code 也有此事件但每次工具失败都触发，太吵——CLI 不给 Claude 装它；
    // 走到这里的是主动挂了该事件的工具（ZCode / Cursor 兜底）
    const detail = input.message || input.error_message || '';
    return { title: `工具调用失败${where}`, body: `${input.tool_name ?? 'tool'}${detail ? `：${detail}` : ''}`.slice(0, 2000), severity: 'warning', tags: 'agent-hook|tool-failure' };
  }

  if (event === 'StopFailure') {
    return {
      title: `Agent 回合失败${where}`,
      body: `${input.error ?? 'unknown'}${input.error_details ? `：${input.error_details}` : ''}`.slice(0, 2000),
      severity: 'critical', tags: 'agent-hook|error'
    };
  }

  if (event === 'SubagentStop') {
    return { title: `子代理完成（${input.agent_type ?? 'agent'}）${where}`, body: lastMessage(input).slice(0, 400) || '子代理回合结束。', severity: 'info', tags: 'agent-hook|subagent' };
  }

  if (event === 'SessionEnd') {
    // Claude Code 的 SessionEnd（clear/logout 等）无行动价值；Cursor 的 sessionEnd
    // 带 reason=error + error_message——会话死于错误要按 critical 告警
    if (input.reason === 'error') {
      return { title: `会话异常终止${where}`, body: (lastMessage(input) || '会话以错误结束').slice(0, 2000), severity: 'critical', tags: 'agent-hook|error' };
    }
    return undefined;
  }

  return undefined;
}

/** 处理 POST /api/v1/hooks/agent（与 /api/v1/hooks/claude 同一处理器的别名） */
export async function handleClaudeHook(
  repository: RelayRepository,
  notifications: NotificationService,
  body: unknown,
  token: string,
  destination: string | undefined,
  drain: () => void,
  minSeverity: Severity | undefined = undefined
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const input = (body && typeof body === 'object' ? body : {}) as HookInput;
  const mapped = claudeHookToNotification(input);
  if (!mapped) return { statusCode: 200, body: { ok: true, ignored: true, event: input.hook_event_name ?? input.type ?? null } };
  // 通知条件过滤：低于选定级别的事件收下不转发（用户/Agent 安装时自选，改 URL 即改条件）
  if (minSeverity !== undefined && SEVERITY_ORDER[mapped.severity] < SEVERITY_ORDER[minSeverity]) {
    return { statusCode: 200, body: { ok: true, filtered: true, severity: mapped.severity } };
  }
  // 先验 key：无效/缺失走 401（与 requireAgent 语义一致；Node 端由中间件前置，DO 端这里补）
  if (!token || !(await repository.authenticateKey(token))) {
    return { statusCode: 401, body: { ok: false, error: '无效或已吊销的 Agent API Key' } };
  }
  try {
    const delivery = await sendWithAgentKey(repository, notifications, token, { destination, ...mapped, metadata: { via: 'agent-hook' } }, 'agent-hook');
    drain();
    return { statusCode: 200, body: { ok: true, deliveryId: delivery.id } };
  } catch (error) {
    // 配置类错误（key 多目的地等）用 4xx 回给用户看；各家 CLI 对非 2xx 只记 debug 不影响会话
    return { statusCode: 400, body: { ok: false, error: error instanceof Error ? error.message : String(error) } };
  }
}
