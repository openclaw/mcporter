import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { gzipSync, deflateSync, brotliCompressSync, createGzip, constants } from 'node:zlib';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { describe, expect, it } from 'vitest';
import { createRuntime } from '../src/runtime.js';
import { nodeHttp1Fetch } from '../src/runtime/node-http-fetch.js';

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  return `http://127.0.0.1:${address.port}/mcp`;
}
async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

describe.each([true, false])('actual HTTP MCP server JSON response mode %s', (enableJsonResponse) => {
  it.each([
    ['gzip', gzipSync],
    ['deflate', deflateSync],
    ['br', brotliCompressSync],
    ['gzip, br', (body: Buffer) => brotliCompressSync(gzipSync(body))],
  ] as const)('decodes %s responses through the actual runtime and HTTP MCP server', async (encoding, compress) => {
    const mcp = new McpServer({ name: 'compressed-proof', version: '1.0.0' });
    mcp.registerTool('echo', { inputSchema: {} }, async () => ({
      content: [{ type: 'text', text: 'decoded MCP result' }],
    }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse });
    await mcp.connect(transport);
    const backend = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks).toString();
        await transport.handleRequest(request, response, body ? JSON.parse(body) : undefined);
      })().catch((error: unknown) => response.destroy(error as Error));
    });
    const backendUrl = await listen(backend);
    const proxy = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const headers = new Headers();
        for (const [name, value] of Object.entries(request.headers))
          if (value !== undefined && !['host', 'content-length'].includes(name))
            headers.set(name, Array.isArray(value) ? value.join(',') : value);
        const original = await fetch(backendUrl, {
          method: request.method,
          headers,
          body: chunks.length ? Buffer.concat(chunks) : undefined,
        });
        original.headers.forEach((value, name) => {
          if (name !== 'transfer-encoding') response.setHeader(name, value);
        });
        const raw = Buffer.from(await original.arrayBuffer());
        const body = raw.length ? compress(raw) : raw;
        if (raw.length) response.setHeader('content-encoding', encoding);
        response.setHeader('content-length', String(body.length));
        response.writeHead(original.status);
        response.end(body);
      })().catch((error: unknown) => response.destroy(error as Error));
    });
    const url = await listen(proxy);
    const runtime = await createRuntime({
      servers: [
        {
          name: 'compressed',
          command: { kind: 'http', url: new URL(url), headers: { 'Accept-Encoding': encoding } },
          protocolVersion: 'legacy',
          httpFetch: 'node-http1',
        },
      ],
    });
    try {
      const tools = await runtime.listTools('compressed');
      expect(tools.map((tool) => tool.name)).toEqual(['echo']);
      const result = await runtime.callTool('compressed', 'echo', { args: {} });
      expect(result).toMatchObject({ content: [{ type: 'text', text: 'decoded MCP result' }] });
    } finally {
      await runtime.close();
      await mcp.close();
      await close(proxy);
      await close(backend);
    }
  });
});

it('preserves plain responses and reports malformed compressed body errors', async () => {
  const server = createServer((request, response) => {
    if (request.url === '/plain') response.end('plain control');
    else {
      response.setHeader('content-encoding', 'gzip');
      response.end('invalid gzip bytes');
    }
  });
  const url = await listen(server);
  try {
    const plain = await nodeHttp1Fetch(url.replace('/mcp', '/plain'));
    expect(await plain.text()).toBe('plain control');
    const corrupt = await nodeHttp1Fetch(url);
    expect(corrupt.headers.get('content-encoding')).toBe('gzip');
    await expect(corrupt.text()).rejects.toThrow();
  } finally {
    await close(server);
  }
});

it.each(['HEAD', 'POST'])('does not decode an empty %s response with a gzip header', async (method) => {
  const server = createServer((_request, response) => {
    response.writeHead(method === 'HEAD' ? 200 : 202, {
      'content-encoding': 'gzip',
      'content-length': method === 'HEAD' ? '123' : '0',
    });
    response.end();
  });
  const url = await listen(server);
  try {
    const response = await nodeHttp1Fetch(url, { method });
    expect(await response.text()).toBe('');
    expect(response.headers.get('content-encoding')).toBe('gzip');
  } finally {
    await close(server);
  }
});

it('decodes a gzip SSE event before the response ends and propagates cancellation', async () => {
  const disconnected = Promise.withResolvers<void>();
  const event = 'data: {"message":"incremental"}\n\n';
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream', 'content-encoding': 'gzip' });
    const gzip = createGzip({ flush: constants.Z_SYNC_FLUSH });
    gzip.pipe(response);
    response.on('close', () => {
      gzip.destroy();
      disconnected.resolve();
    });
    gzip.write(event);
  });
  const url = await listen(server);
  const controller = new AbortController();
  try {
    const response = await nodeHttp1Fetch(url, { signal: controller.signal });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toBe(event);
    const pending = expect(reader.read()).rejects.toThrow();
    controller.abort();
    await pending;
    await disconnected.promise;
  } finally {
    controller.abort();
    await close(server);
  }
});
