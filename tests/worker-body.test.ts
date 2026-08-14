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
});
