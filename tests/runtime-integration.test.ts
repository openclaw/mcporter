import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createRuntime } from '../src/runtime.js';

const app = express();
app.use(express.json());
app.get('/mcp', (_req, res) => {
  res.sendStatus(405);
});

const server = new McpServer({
  name: 'integration-demo',
  version: '1.0.0',
});

server.registerTool(
  'add',
  {
    title: 'Addition Tool',
    description: 'Add two numbers',
    inputSchema: { a: z.number(), b: z.number() },
    outputSchema: { result: z.number() },
  },
  async ({ a, b }) => {
    const result = { result: a + b };
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      structuredContent: result,
    };
  }
);

server.registerResource(
  'greeting',
  new ResourceTemplate('greeting://{name}', { list: undefined }),
  {
    title: 'Greeting',
    description: 'Dynamic greeting resource',
  },
  async (uri, { name }) => {
    const normalizedName = typeof name === 'string' ? name : Array.isArray(name) ? name.join(', ') : 'friend';

    return {
      contents: [
        {
          uri: uri.href,
          text: `Hello, ${normalizedName}!`,
        },
      ],
    };
  }
);

app.post('/mcp', async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  res.on('close', () => {
    transport.close().catch(() => {});
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

let httpServer: HttpServer;
let baseUrl: URL;

describe('runtime integration', () => {
  beforeAll(async () => {
    httpServer = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve, reject) => {
      httpServer.once('listening', resolve);
      httpServer.once('error', reject);
    });
    const address = httpServer.address() as AddressInfo;
    baseUrl = new URL(`http://127.0.0.1:${address.port}/mcp`);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it('lists tools and calls a tool over HTTP', async () => {
    const runtime = await createRuntime({
      servers: [
        {
          name: 'integration',
          description: 'Integration test server',
          command: { kind: 'http', url: baseUrl },
        },
      ],
    });

    const tools = await runtime.listTools('integration');
    expect(tools.some((tool) => tool.name === 'add')).toBe(true);

    const result = (await runtime.callTool('integration', 'add', {
      args: { a: 3, b: 4 },
    })) as { structuredContent?: { result: number } };

    expect(result.structuredContent?.result).toBe(7);

    await runtime.close('integration');
  });

  it('lists and reads resources over HTTP', async () => {
    const runtime = await createRuntime({
      servers: [
        {
          name: 'integration',
          description: 'Integration test server',
          command: { kind: 'http', url: baseUrl },
        },
      ],
    });

    const listed = (await runtime.listResources('integration')) as { resources?: Array<{ uri: string }> };
    expect(Array.isArray(listed.resources)).toBe(true);

    const result = (await runtime.readResource('integration', 'greeting://Ada')) as {
      contents?: Array<{ uri: string; text?: string }>;
    };
    expect(result.contents?.[0]?.uri).toBe('greeting://Ada');
    expect(result.contents?.[0]?.text).toBe('Hello, Ada!');

    await runtime.close('integration');
  });

  it('reuses cached connection when disableOAuth: true is passed', async () => {
    // Headless-daemon use case: the caller wants OAuth suppression
    // (no browser launches) but still expects connection caching so
    // every callTool doesn't spawn a fresh transport. Previously the
    // only way to suppress OAuth was `maxOAuthAttempts: 0`, which
    // forced `useCache = false` as a side effect — see the connect()
    // gate. `disableOAuth: true` preserves caching.
    const runtime = await createRuntime({
      servers: [
        {
          name: 'integration',
          description: 'Integration test server',
          command: { kind: 'http', url: baseUrl },
        },
      ],
    });

    const first = await runtime.connect('integration', { disableOAuth: true });
    const second = await runtime.connect('integration', { disableOAuth: true });
    expect(second).toBe(first);

    // close() reaps the cached client.
    await runtime.close('integration');
    const reopened = await runtime.connect('integration', { disableOAuth: true });
    expect(reopened).not.toBe(first);

    await runtime.close('integration');
  });

  it('treats disableOAuth: false like omitted for cache identity', async () => {
    const runtime = await createRuntime({
      servers: [
        {
          name: 'integration',
          description: 'Integration test server',
          command: { kind: 'http', url: baseUrl },
        },
      ],
    });

    const explicitFalse = await runtime.connect('integration', { disableOAuth: false });
    const omitted = await runtime.connect('integration', {});
    expect(omitted).toBe(explicitFalse);

    await runtime.close('integration');
  });

  it('maxOAuthAttempts: 0 still bypasses the cache (existing contract preserved)', async () => {
    // Regression guard: callers passing maxOAuthAttempts: 0 today get
    // a fresh client per call. That contract is unchanged — only the
    // new `disableOAuth` flag enables caching with OAuth suppression.
    const runtime = await createRuntime({
      servers: [
        {
          name: 'integration',
          description: 'Integration test server',
          command: { kind: 'http', url: baseUrl },
        },
      ],
    });

    const first = await runtime.connect('integration', { maxOAuthAttempts: 0 });
    const second = await runtime.connect('integration', { maxOAuthAttempts: 0 });
    expect(second).not.toBe(first);

    await runtime.close('integration');
  });

  it('evicts and re-establishes the cached client when disableOAuth flag changes', async () => {
    // Connections established with disableOAuth: true vs without are
    // semantically different (the former cannot inherit an OAuth
    // session that may refresh into a flow). The cache slot must not
    // be shared across that boundary.
    const runtime = await createRuntime({
      servers: [
        {
          name: 'integration',
          description: 'Integration test server',
          command: { kind: 'http', url: baseUrl },
        },
      ],
    });

    const cached = await runtime.connect('integration', { disableOAuth: true });
    const withFlowAllowed = await runtime.connect('integration', {});
    expect(withFlowAllowed).not.toBe(cached);

    await runtime.close('integration');
  });

  it('preserves the cached client across connect(disableOAuth:true) → callTool() (no implicit eviction)', async () => {
    // Regression for the PR-198 review note (Codex r3366238654): the
    // documented headless setup is `await runtime.connect(server, {
    // disableOAuth: true })`. That call stored the cache slot with
    // `allowCachedAuth: undefined`. The subsequent internal
    // `callTool()` path forces `allowCachedAuth: true`, and the
    // cache-match check (existing.allowCachedAuth === options.allowCachedAuth
    // || options.allowCachedAuth === undefined) treated the two as
    // structurally different — every first callTool evicted and
    // reopened the transport. Defeats the pooling guarantee for the
    // common pre-connect path.
    const runtime = await createRuntime({
      servers: [
        {
          name: 'integration',
          description: 'Integration test server',
          command: { kind: 'http', url: baseUrl },
        },
      ],
    });

    const initial = await runtime.connect('integration', { disableOAuth: true });

    const callResult = (await runtime.callTool('integration', 'add', {
      args: { a: 1, b: 2 },
    })) as { structuredContent?: { result: number } };
    expect(callResult.structuredContent?.result).toBe(3);

    // After callTool, the cache slot should still hold the same
    // ClientContext established by the prior connect() — no eviction,
    // no extra transport spawned.
    const afterCall = await runtime.connect('integration', { disableOAuth: true });
    expect(afterCall).toBe(initial);

    await runtime.close('integration');
  });

  it('preserves the cached client across connect(disableOAuth:true) → listTools() (no implicit eviction)', async () => {
    // Same shape as the callTool regression: listTools also forces
    // `allowCachedAuth: options.allowCachedAuth ?? true` internally,
    // so the pre-connected slot was being evicted on first listTools.
    const runtime = await createRuntime({
      servers: [
        {
          name: 'integration',
          description: 'Integration test server',
          command: { kind: 'http', url: baseUrl },
        },
      ],
    });

    const initial = await runtime.connect('integration', { disableOAuth: true });
    const tools = await runtime.listTools('integration');
    expect(tools.some((tool) => tool.name === 'add')).toBe(true);

    const afterList = await runtime.connect('integration', { disableOAuth: true });
    expect(afterList).toBe(initial);

    await runtime.close('integration');
  });
});
