import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { createBridgeServer, decodeToolName } from '../src/serve.js';

const definition: ServerDefinition = {
  name: 'alpha',
  command: { kind: 'http', url: new URL('https://alpha.example.com') },
  lifecycle: { mode: 'keep-alive' },
};

describe('serve bridge edge behavior', () => {
  it('rejects an empty bridge and namespaced selectors without a tool name', () => {
    const runtime = { listTools: vi.fn(), callTool: vi.fn() };
    expect(() => createBridgeServer({ runtime, definitions: [] })).toThrow(
      'No keep-alive MCP servers are available to serve'
    );
    expect(decodeToolName('alpha__', [{ name: 'alpha' }])).toBeUndefined();
  });

  it('supplies safe schema and description defaults and rejects unknown bridged tools', async () => {
    const runtime = {
      listTools: vi.fn().mockResolvedValue([{ name: 'ping', inputSchema: { type: 'string' }, outputSchema: [] }]),
      callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'pong' }] }),
    };
    const bridge = createBridgeServer({ runtime, definitions: [definition] });
    const client = new Client({ name: 'edge-client', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([bridge.connect(serverTransport), client.connect(clientTransport)]);

    try {
      await expect(client.listTools()).resolves.toMatchObject({
        tools: [
          {
            name: 'alpha__ping',
            description: "Tool from MCPorter server 'alpha'.",
            inputSchema: { type: 'object' },
          },
        ],
      });
      await expect(client.callTool({ name: 'missing__tool', arguments: {} })).rejects.toThrow(
        "Unknown bridged tool 'missing__tool'"
      );
      expect(runtime.callTool).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await bridge.close();
    }
  });
});
