import http from 'node:http';
import { Readable, Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { pipeHttpResponseBody } from '../src/serve.js';

function createMockResponse(): http.ServerResponse {
  const dest = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  // pipeHttpResponseBody only needs a Writable destination with destroy().
  return dest as unknown as http.ServerResponse;
}

describe('serve HTTP body pipe error cleanup', () => {
  it('destroys the response body when the client response errors', async () => {
    const body = new Readable({
      read() {
        this.push(Buffer.alloc(16, 1));
      },
    });
    const destroySpy = vi.spyOn(body, 'destroy');
    const response = createMockResponse();

    const pipePromise = pipeHttpResponseBody(body, response);
    // Simulate client abort / socket error on the HTTP response side.
    response.emit('error', new Error('socket hang up'));

    await expect(pipePromise).resolves.toBeUndefined();
    expect(destroySpy).toHaveBeenCalled();
    expect(body.destroyed).toBe(true);
  });

  it('destroys the HTTP response when the body stream errors', async () => {
    const body = new Readable({
      read() {
        this.push(Buffer.alloc(8, 2));
      },
    });
    const response = createMockResponse();
    const destroySpy = vi.spyOn(response, 'destroy');

    const pipePromise = pipeHttpResponseBody(body, response);
    body.destroy(new Error('upstream truncated'));

    await expect(pipePromise).resolves.toBeUndefined();
    expect(destroySpy).toHaveBeenCalled();
    expect(response.destroyed).toBe(true);
  });
});
