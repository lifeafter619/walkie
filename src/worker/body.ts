const MAX_BODY_BYTES = 262_144;

export class BodyTooLargeError extends Error {
  constructor() {
    super('请求体不能超过 256KB');
    this.name = 'BodyTooLargeError';
  }
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) throw new BodyTooLargeError();

  let text = '';
  let bytes = 0;
  if (request.body) {
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BODY_BYTES) {
          await reader.cancel();
          throw new BodyTooLargeError();
        }
        text += decoder.decode(value, { stream: true });
      }
      text += decoder.decode();
    } finally {
      reader.releaseLock();
    }
  }

  if (!text) return {};
  const contentType = request.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) return JSON.parse(text) as Record<string, unknown>;
  return Object.fromEntries(new URLSearchParams(text));
}
