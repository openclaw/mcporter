import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, inputRequired, inputResponse, McpServer } from '@modelcontextprotocol/server';
import { InMemoryTransport as LegacyInMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer as LegacyMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createNonInteractiveElicitationResponder,
  type ElicitationHandler,
  NON_INTERACTIVE_ELICITATION_HINT,
  registerElicitationHandler,
} from '../src/runtime/elicitation.js';

const connectedClients: Array<{ close(): Promise<void> }> = [];
const connectedServers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.allSettled(connectedClients.splice(0).map((client) => client.close()));
  await Promise.allSettled(connectedServers.splice(0).map((server) => server.close()));
});

describe('elicitation responder', () => {
  it('fulfils modern input_required results through the registered handler', async () => {
    const scripted: ElicitationHandler = vi.fn(async (request) => {
      expect(request.params).toMatchObject({ message: 'Where should this run?' });
      return { action: 'accept' as const, content: { environment: 'staging', replicas: 2 } };
    });
    const client = createClient(scripted, 'legacy');
    const server = new McpServer({ name: 'modern-elicitation-test', version: '1.0.0' });
    server.registerTool('deploy', {}, async (ctx) => {
      const response = inputResponse(ctx.mcpReq.inputResponses, 'deployment');
      if (response.kind !== 'elicit') {
        return inputRequired({
          inputRequests: {
            deployment: inputRequired.elicit({
              message: 'Where should this run?',
              requestedSchema: {
                type: 'object',
                properties: {
                  environment: { type: 'string', enum: ['staging', 'production'] },
                  replicas: { type: 'integer', default: 1 },
                },
                required: ['environment'],
              },
            }),
          },
          requestState: 'deploy-v1',
        });
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(response) }],
      };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    promoteInMemoryPairToModern(client, server, clientTransport, serverTransport);
    connectedClients.push(client);
    connectedServers.push(server);

    const result = await client.callTool({ name: 'deploy', arguments: {} });

    expect(result.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({
          kind: 'elicit',
          action: 'accept',
          content: { environment: 'staging', replicas: 2 },
        }),
      },
    ]);
    expect(scripted).toHaveBeenCalledOnce();
  });

  it('uses the same registered handler for a legacy server-initiated request', async () => {
    const scripted: ElicitationHandler = vi.fn(async () => ({
      action: 'accept' as const,
      content: { project: 'mcporter' },
    }));
    const client = createClient(scripted, 'legacy');
    const server = new LegacyMcpServer({ name: 'legacy-elicitation-test', version: '1.0.0' });
    server.registerTool('ask', {}, async () => {
      const result = await server.server.elicitInput({
        mode: 'form',
        message: 'Which project?',
        requestedSchema: {
          type: 'object',
          properties: { project: { type: 'string' } },
          required: ['project'],
        },
      });
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    });

    const [clientTransport, serverTransport] = LegacyInMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    connectedClients.push(client);
    connectedServers.push(server);

    const result = await client.callTool({ name: 'ask', arguments: {} });

    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify({ action: 'accept', content: { project: 'mcporter' } }) },
    ]);
    expect(scripted).toHaveBeenCalledOnce();
  });

  it('declines immediately, surfaces the server response, and emits the terminal hint', async () => {
    const warn = vi.fn();
    const responder = createNonInteractiveElicitationResponder({
      onDecline: () => warn(NON_INTERACTIVE_ELICITATION_HINT),
    });
    const client = createClient(responder.handler, 'legacy');
    const server = new McpServer({ name: 'decline-test', version: '1.0.0' });
    server.registerTool('ask', {}, async (ctx) => {
      const response = inputResponse(ctx.mcpReq.inputResponses, 'question');
      if (response.kind === 'missing') {
        return inputRequired({
          inputRequests: {
            question: inputRequired.elicit({
              message: 'Need a value',
              requestedSchema: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
              },
            }),
          },
        });
      }
      return {
        content: [
          {
            type: 'text',
            text: response.kind === 'elicit' ? `elicitation ${response.action}` : `unexpected ${response.kind}`,
          },
        ],
      };
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    promoteInMemoryPairToModern(client, server, clientTransport, serverTransport);
    connectedClients.push(client);
    connectedServers.push(server);

    const result = await client.callTool({ name: 'ask', arguments: {} });

    expect(result.content).toEqual([{ type: 'text', text: 'elicitation decline' }]);
    expect(responder.didDecline()).toBe(true);
    expect(warn).toHaveBeenCalledWith(NON_INTERACTIVE_ELICITATION_HINT);
  });
});

function createClient(handler: ElicitationHandler, mode: 'legacy'): Client {
  const client = new Client(
    { name: 'mcporter-elicitation-test', version: '1.0.0' },
    {
      capabilities: { elicitation: { form: {}, url: {} } },
      versionNegotiation: { mode },
    }
  );
  registerElicitationHandler(client, handler);
  return client;
}

// Direct InMemoryTransport connections intentionally initialize in the legacy
// era; production modern entry points set the same protocol state after discover.
function promoteInMemoryPairToModern(
  client: Client,
  server: McpServer,
  clientTransport: InMemoryTransport,
  serverTransport: InMemoryTransport
): void {
  const version = '2026-07-28';
  (client as unknown as { _negotiatedProtocolVersion: string })._negotiatedProtocolVersion = version;
  (server.server as unknown as { _negotiatedProtocolVersion: string })._negotiatedProtocolVersion = version;
  (clientTransport as unknown as { setProtocolVersion?(version: string): void }).setProtocolVersion?.(version);
  (serverTransport as unknown as { setProtocolVersion?(version: string): void }).setProtocolVersion?.(version);
}
