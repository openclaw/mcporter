import { createServer } from 'node:http';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { expect, it } from 'vitest';
import { nodeHttp1Fetch } from '../src/runtime/node-http-fetch.js';

it.each([301, 302])('keeps real MCP session termination as DELETE through a %s redirect', async (status) => {
  const methods: string[] = [];
  const sessions: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    if (request.url === '/old') {
      response.writeHead(status, { location: '/current' });
    } else {
      methods.push(request.method ?? '');
      sessions.push(request.headers['mcp-session-id'] as string | undefined);
      response.writeHead(request.method === 'DELETE' ? 204 : 404);
    }
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/old`), {
    sessionId: 'owned-resumed-session',
    fetch: nodeHttp1Fetch,
  });
  try {
    await transport.start();
    await transport.terminateSession();
    expect(methods).toEqual(['DELETE']);
    expect(sessions).toEqual(['owned-resumed-session']);
    expect(transport.sessionId).toBeUndefined();
  } finally {
    await transport.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

it('still rewrites DELETE to GET for a 303 response', async () => {
  const methods: string[] = [];
  const server = createServer((request, response) => {
    if (request.url === '/old') response.writeHead(303, { location: '/current' });
    else {
      methods.push(request.method ?? '');
      response.writeHead(200);
    }
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  try {
    const response = await nodeHttp1Fetch(`http://127.0.0.1:${address.port}/old`, { method: 'DELETE' });
    await response.text();
    expect(methods).toEqual(['GET']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

it.each([301, 302, 303, 307, 308])('keeps the SDK cross-origin boundary for a %s redirect', async (status) => {
  let targetCalls = 0;
  const target = createServer((_request, response) => {
    targetCalls++;
    response.writeHead(204).end();
  });
  const targetUrl = await listen(target);
  const source = createServer((_request, response) => response.writeHead(status, { location: targetUrl }).end());
  const sourceUrl = await listen(source);
  const transport = new StreamableHTTPClientTransport(new URL(sourceUrl), {
    sessionId: 'cross-origin-control',
    fetch: nodeHttp1Fetch,
  });
  try {
    await transport.start();
    await expect(transport.terminateSession()).rejects.toThrow(/not followed/);
    expect(targetCalls).toBe(0);
  } finally {
    await transport.close();
    await close(source);
    await close(target);
  }
});

it.each([
  ['POST', 301],
  ['POST', 302],
  ['DELETE', 303],
] as const)('keeps the SDK method boundary for %s through %s', async (method, status) => {
  let targetCalls = 0;
  const server = createServer((request, response) => {
    if (request.url === '/old') response.writeHead(status, { location: '/current' }).end();
    else {
      targetCalls++;
      response.writeHead(202).end();
    }
  });
  const url = await listen(server);
  const transport = new StreamableHTTPClientTransport(new URL(`${url}old`), {
    sessionId: 'method-control',
    fetch: nodeHttp1Fetch,
  });
  try {
    await transport.start();
    await expect(
      method === 'DELETE'
        ? transport.terminateSession()
        : transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    ).rejects.toThrow(/not followed/);
    expect(targetCalls).toBe(0);
  } finally {
    await transport.close();
    await close(server);
  }
});

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  return `http://127.0.0.1:${address.port}/`;
}

async function close(server: ReturnType<typeof createServer>): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
