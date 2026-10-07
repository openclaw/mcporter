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
