#!/usr/bin/env tsx

/**
 * Demonstration: `disableOAuth: true` provides cache-friendly OAuth
 * suppression for headless callers.
 *
 * Spins up a local mock MCP server (no real auth), then exercises three
 * patterns side-by-side and counts the distinct ClientContext objects
 * the runtime hands out:
 *
 *   1. Legacy `maxOAuthAttempts: 0`         — uncached (existing contract).
 *   2. `disableOAuth: true` direct connects — pooled.
 *   3. The documented headless setup        — pre-connect with
 *      `disableOAuth: true`, then 5 `callTool` invocations. Verifies the
 *      pre-connected slot is preserved (no implicit eviction).
 *
 * Run:  pnpm tsx examples/headless-pooling-demo.ts
 *
 * Counting strategy: ClientContext object identity. Each call to
 * `createClientContext` inside the runtime returns a fresh object;
 * cached calls return the same object. We track the set of unique
 * objects and report cardinality.
 */

import type { Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express from 'express';
import { z } from 'zod';
import { createRuntime } from '../src/index.js';

const INVOCATIONS = 5;

async function startMockServer(): Promise<{ baseUrl: URL; httpServer: HttpServer }> {
  const app = express();
  app.use(express.json());

  const mcp = new McpServer({ name: 'demo', version: '1.0.0' });
  mcp.registerTool(
    'add',
    {
      title: 'Addition',
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

  app.get('/mcp', (_req, res) => res.sendStatus(405));
  app.post('/mcp', async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      transport.close().catch(() => {});
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  const httpServer = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    httpServer.once('listening', resolve);
    httpServer.once('error', reject);
  });
  const address = httpServer.address() as AddressInfo;
  return { baseUrl: new URL(`http://127.0.0.1:${address.port}/mcp`), httpServer };
}

async function main(): Promise<void> {
  // The mock MCP server below has no `auth: 'oauth'` definition, so the
  // OAuth flow is not exercised here. This demo focuses on the
  // cache-behavior fix (the main fix in PR #198). OAuth-suppression
  // semantics under `disableOAuth: true` are exercised by the unit
  // tests in `tests/runtime-transport.test.ts` (shouldEstablishOAuth)
  // and `tests/runtime-integration.test.ts` (cache + eviction).
  const { baseUrl, httpServer } = await startMockServer();
  console.log(`[demo] Mock MCP server listening at ${baseUrl}\n`);

  try {
    // ----- Pattern A: legacy maxOAuthAttempts: 0 (uncached) ------------
    {
      const runtime = await createRuntime({
        servers: [
          {
            name: 'demo',
            description: 'Demo server',
            command: { kind: 'http', url: baseUrl },
          },
        ],
      });
      const contexts = new Set<unknown>();
      for (let i = 0; i < INVOCATIONS; i++) {
        contexts.add(await runtime.connect('demo', { maxOAuthAttempts: 0 }));
      }
      console.log(`[demo] Pattern A — legacy maxOAuthAttempts: 0`);
      console.log(`[demo]   ${INVOCATIONS} connect() calls → ${contexts.size} distinct ClientContexts`);
      console.log(`[demo]   Expected: ${INVOCATIONS} (legacy contract: cache disabled when maxOAuthAttempts is set)`);
      console.log(`[demo]   Result:   ${contexts.size === INVOCATIONS ? 'OK' : 'UNEXPECTED'}\n`);
      await runtime.close();
    }

    // ----- Pattern B: disableOAuth: true on every connect ---------------
    {
      const runtime = await createRuntime({
        servers: [
          {
            name: 'demo',
            description: 'Demo server',
            command: { kind: 'http', url: baseUrl },
          },
        ],
      });
      const contexts = new Set<unknown>();
      for (let i = 0; i < INVOCATIONS; i++) {
        contexts.add(await runtime.connect('demo', { disableOAuth: true }));
      }
      console.log(`[demo] Pattern B — disableOAuth: true on every connect`);
      console.log(`[demo]   ${INVOCATIONS} connect() calls → ${contexts.size} distinct ClientContexts`);
      console.log(`[demo]   Expected: 1 (cache reuse under cache-friendly suppression)`);
      console.log(`[demo]   Result:   ${contexts.size === 1 ? 'PASS' : 'FAIL'}\n`);
      await runtime.close();
    }

    // ----- Pattern C: documented headless setup + 5 callTool ------------
    {
      const runtime = await createRuntime({
        servers: [
          {
            name: 'demo',
            description: 'Demo server',
            command: { kind: 'http', url: baseUrl },
          },
        ],
      });
      const initial = await runtime.connect('demo', { disableOAuth: true });
      let sum = 0;
      for (let i = 0; i < INVOCATIONS; i++) {
        const result = (await runtime.callTool('demo', 'add', {
          args: { a: i, b: i + 1 },
        })) as { structuredContent?: { result: number } };
        sum += result.structuredContent?.result ?? 0;
      }
      const afterCalls = await runtime.connect('demo', { disableOAuth: true });
      const reused = afterCalls === initial;
      console.log(`[demo] Pattern C — pre-connect(disableOAuth:true) + ${INVOCATIONS} callTool()`);
      console.log(`[demo]   Sum of ${INVOCATIONS} add() results: ${sum}`);
      console.log(`[demo]   Post-callTool connect() === pre-connect ClientContext: ${reused}`);
      console.log(`[demo]   Expected: true (no implicit eviction from callTool internals)`);
      console.log(`[demo]   Result:   ${reused ? 'PASS' : 'FAIL'}\n`);
      await runtime.close();
    }
  } finally {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
