const MAX_WALKIE_HOPS = 8;

const origin = (value: string): string | undefined => {
  try { return new URL(value).origin.toLowerCase(); }
  catch { return; }
};

export function parseWalkieTrace(value: unknown): string[] {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.slice(0, MAX_WALKIE_HOPS).flatMap((item) => typeof item === 'string' && origin(item) ? [origin(item)!] : []))];
  } catch { return []; }
}

export function appendWalkieTrace(value: unknown, target: string): string[] {
  const trace = parseWalkieTrace(value);
  const targetOrigin = origin(target);
  if (!targetOrigin) throw new Error('远端 Walkie 地址无效');
  if (trace.includes(targetOrigin)) throw new Error(`检测到通知回环，已阻止再次发送到 ${targetOrigin}`);
  if (trace.length >= MAX_WALKIE_HOPS) throw new Error(`跨实例通知已超过 ${MAX_WALKIE_HOPS} 跳，已阻止继续转发`);
  return [...trace, targetOrigin];
}
