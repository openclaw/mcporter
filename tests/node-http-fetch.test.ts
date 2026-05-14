import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { nodeHttp1Fetch } from '../src/runtime/node-http-fetch.js';

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

describe('nodeHttp1Fetch', () => {
  it('follows redirects by default', async () => {
    const { baseUrl, close } = await serve((request, response) => {
      if (request.url === '/start') {
        response.writeHead(302, { location: '/final' });
        response.end();
        return;
      }
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end(`ok:${request.method}:${request.url}`);
    });
    cleanup = close;

    const response = await nodeHttp1Fetch(new URL('/start', baseUrl));

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok:GET:/final');
  });

  it('preserves method and body for 307 redirects', async () => {
    const { baseUrl, close } = await serve((request, response) => {
      if (request.url === '/start') {
        response.writeHead(307, { location: '/target' });
        response.end();
        return;
      }
      let body = '';
      request.setEncoding('utf8');
      request.on('data', (chunk: string) => {
        body += chunk;
      });
      request.on('end', () => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ method: request.method, body }));
      });
    });
    cleanup = close;

    const response = await nodeHttp1Fetch(new URL('/start', baseUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ method: 'POST', body: '{"ok":true}' });
  });

  it('honors manual redirect mode', async () => {
    const { baseUrl, close } = await serve((_request, response) => {
      response.writeHead(302, { location: '/final' });
      response.end();
    });
    cleanup = close;

    const response = await nodeHttp1Fetch(new URL('/start', baseUrl), { redirect: 'manual' });

    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('/final');
    await response.body?.cancel();
  });

  it('rejects malformed redirect locations', async () => {
    const { baseUrl, close } = await serve((_request, response) => {
      response.writeHead(302, { location: 'http://[' });
      response.end();
    });
    cleanup = close;

    await expect(nodeHttp1Fetch(new URL('/start', baseUrl))).rejects.toThrow();
  });

  it('strips sensitive request headers on cross-origin redirects', async () => {
    let redirectedHeaders: IncomingMessage['headers'] | undefined;
    const target = await serve((request, response) => {
      redirectedHeaders = request.headers;
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
    });
    const source = await serve((_request, response) => {
      response.writeHead(302, { location: new URL('/target', target.baseUrl).href });
      response.end();
    });
    cleanup = async () => {
      await source.close();
      await target.close();
    };

    const response = await nodeHttp1Fetch(new URL('/start', source.baseUrl), {
      headers: {
        Authorization: 'Bearer secret',
        Cookie: 'sid=secret',
        'Proxy-Authorization': 'Basic secret',
        'X-Keep': 'ok',
      },
    });

    expect(response.status).toBe(200);
    await response.body?.cancel();
    expect(redirectedHeaders?.authorization).toBeUndefined();
    expect(redirectedHeaders?.cookie).toBeUndefined();
    expect(redirectedHeaders?.['proxy-authorization']).toBeUndefined();
    expect(redirectedHeaders?.['x-keep']).toBe('ok');
  });

  it('handles null-body response statuses', async () => {
    const { baseUrl, close } = await serve((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    cleanup = close;

    const response = await nodeHttp1Fetch(new URL('/empty', baseUrl));

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });
});

type HttpHandler = (request: IncomingMessage, response: ServerResponse) => void;

async function serve(handler: HttpHandler): Promise<{ baseUrl: URL; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP test server address.');
  }
  return {
    baseUrl: new URL(`http://127.0.0.1:${address.port}`),
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
