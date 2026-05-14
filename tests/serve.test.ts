import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { createBridgeServer, decodeToolName, encodeToolName, selectServedServers, serveHttp } from '../src/serve.js';

const definitions: ServerDefinition[] = [
  {
    name: 'alpha',
    description: 'keep alive server',
    command: { kind: 'http', url: new URL('https://alpha.example.com') },
    lifecycle: { mode: 'keep-alive' },
    source: { kind: 'local', path: '/tmp' },
  },
  {
    name: 'alpha-long',
    description: 'keep alive server',
    command: { kind: 'http', url: new URL('https://alpha-long.example.com') },
    lifecycle: { mode: 'keep-alive' },
    source: { kind: 'local', path: '/tmp' },
  },
  {
    name: 'beta',
    description: 'ephemeral server',
    command: { kind: 'http', url: new URL('https://beta.example.com') },
    source: { kind: 'local', path: '/tmp' },
  },
];

describe('mcporter serve bridge', () => {
  it('selects only keep-alive servers and validates explicit filters', () => {
    expect(selectServedServers(definitions).map((entry) => entry.name)).toEqual(['alpha', 'alpha-long']);
    expect(selectServedServers(definitions, ['alpha']).map((entry) => entry.name)).toEqual(['alpha']);
    expect(() => selectServedServers(definitions, ['beta'])).toThrow("Server 'beta' is not configured for keep-alive");
  });

  it('encodes and decodes namespaced tool names with longest-prefix matching', () => {
    expect(encodeToolName('alpha', 'ping')).toBe('alpha__ping');
    expect(decodeToolName('alpha-long__tool__with__separator', [{ name: 'alpha' }, { name: 'alpha-long' }])).toEqual({
      server: 'alpha-long',
      tool: 'tool__with__separator',
    });
  });

  it('exposes daemon tools through a single MCP server', async () => {
    const runtime = {
      listTools: vi.fn().mockImplementation(async (server: string) => [
        {
          name: 'ping',
          description: `${server} ping`,
          inputSchema: {
            type: 'object',
            properties: { value: { type: 'number' } },
            required: ['value'],
          },
        },
      ]),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'pong' }],
      }),
    };
    const bridge = createBridgeServer({
      runtime,
      definitions,
      servers: ['alpha'],
    });
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([bridge.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    expect(tools.tools).toEqual([
      expect.objectContaining({
        name: 'alpha__ping',
        description: '[alpha] alpha ping',
        inputSchema: expect.objectContaining({ required: ['value'] }),
      }),
    ]);
    expect(runtime.listTools).toHaveBeenCalledWith('alpha', {
      includeSchema: true,
      autoAuthorize: true,
    });

    await expect(client.callTool({ name: 'alpha__ping', arguments: { value: 1 } })).resolves.toEqual({
      content: [{ type: 'text', text: 'pong' }],
    });
    expect(runtime.callTool).toHaveBeenCalledWith('alpha', 'ping', {
      args: { value: 1 },
    });

    await client.close();
    await bridge.close();
  });

  it('serves the bridge over Streamable HTTP', async () => {
    const runtime = {
      listTools: vi.fn().mockResolvedValue([
        {
          name: 'ping',
          inputSchema: { type: 'object' },
        },
      ]),
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'pong-http' }],
      }),
    };
    const httpServer = await serveHttp({
      runtime,
      definitions,
      servers: ['alpha'],
      port: 0,
    });
    const address = httpServer.address();
    if (!address || typeof address !== 'object') {
      throw new Error('Expected test HTTP server to listen on a TCP port.');
    }
    expect(address.address).toBe('127.0.0.1');

    const client = new Client({ name: 'test-http-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`));
    try {
      await client.connect(transport);
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual(['alpha__ping']);
      await expect(client.callTool({ name: 'alpha__ping', arguments: {} })).resolves.toEqual({
        content: [{ type: 'text', text: 'pong-http' }],
      });
    } finally {
      await client.close().catch(() => {});
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });

  it('returns 404 for paths outside the MCP endpoint', async () => {
    const runtime = {
      listTools: vi.fn(),
      callTool: vi.fn(),
    };
    const httpServer = await serveHttp({
      runtime,
      definitions,
      servers: ['alpha'],
      port: 0,
    });
    const address = httpServer.address();
    if (!address || typeof address !== 'object') {
      throw new Error('Expected test HTTP server to listen on a TCP port.');
    }
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp-extra`);
      expect(response.status).toBe(404);
    } finally {
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    }
  });
});
