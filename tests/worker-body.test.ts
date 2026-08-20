import { describe, expect, it } from 'vitest';
import { BodyTooLargeError, readBody } from '../src/worker/body.js';

describe('worker body limits', () => {
  it('rejects oversized chunked bodies before buffering them', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(262_144));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      }
    });
    await expect(readBody(new Request('https://relay.example.com/api', { method: 'POST', body, duplex: 'half' }))).rejects.toBeInstanceOf(BodyTooLargeError);
  });

  // Gotify 官方示例 curl -F 走 multipart；此前 readBody 会把它当 urlencoded 解出垃圾键
  it('parses multipart/form-data fields (Gotify curl -F compatibility)', async () => {
    const boundary = '----walkie-test';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nfrom curl -F\r\n--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\nmultipart body\r\n--${boundary}\r\nContent-Disposition: form-data; name="priority"\r\n\r\n8\r\n--${boundary}--\r\n`;
    const request = new Request('https://relay.example.com/message', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body
    });
    await expect(readBody(request)).resolves.toEqual({ title: 'from curl -F', message: 'multipart body', priority: '8' });
  });

  it('ignores file parts but keeps other fields in multipart bodies', async () => {
    const boundary = '----walkie-test';
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="message"\r\n\r\ntext value\r\n--${boundary}\r\nContent-Disposition: form-data; name="attachment"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nfile content\r\n--${boundary}--\r\n`;
    const request = new Request('https://relay.example.com/message', {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body
    });
    const parsed = await readBody(request);
    expect(parsed.message).toBe('text value');
    expect(parsed.attachment).toBeUndefined();
  });
});
