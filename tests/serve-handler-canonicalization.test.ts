import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createMcpHandler: vi.fn() }));

vi.mock('@modelcontextprotocol/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@modelcontextprotocol/server')>();
  mocks.createMcpHandler.mockImplementation(actual.createMcpHandler);
  return { ...actual, createMcpHandler: mocks.createMcpHandler };
});

import type { ServerDefinition } from '../src/config.js';
import { serveHttp } from '../src/serve.js';

const definition: ServerDefinition = {
  name: 'alpha',
  command: { kind: 'http', url: new URL('https://alpha.example/mcp') },
  lifecycle: { mode: 'keep-alive' },
};

afterEach(() => {
  mocks.createMcpHandler.mockClear();
});

describe('serve handler canonicalization', () => {
  it('shares one handler across equivalent encoded server paths', async () => {
    const server = await serveHttp({
      runtime: { listTools: vi.fn(), callTool: vi.fn() },
      definitions: [definition],
      servers: ['alpha'],
      port: 0,
    });
    const address = server.address();
    if (!address || typeof address !== 'object') throw new Error('Expected a listening HTTP server.');

    try {
      for (const pathname of ['/mcp/alpha', '/mcp/%61lpha', '/mcp/a%6cpha']) {
        await fetch(`http://127.0.0.1:${address.port}${pathname}`);
      }
      expect(mocks.createMcpHandler).toHaveBeenCalledOnce();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
