import { Client } from '@modelcontextprotocol/client';
import type { ElicitRequest } from '@modelcontextprotocol/client';
import { InMemoryTransport, inputRequired, inputResponse, McpServer } from '@modelcontextprotocol/server';
import { InMemoryTransport as LegacyInMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer as LegacyMcpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createInteractiveElicitationResponder,
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

// readline emits its own cursor-positioning codes when rendering a prompt to a
// non-TTY stream; those are generated locally and never derived from server
// input. Assert on the classes an attacker could actually smuggle instead.
function expectNoInjectedControlSequences(output: string): void {
  expect(output).not.toContain('\u0007'); // BEL (OSC terminator)
  expect(output).not.toContain('\u001b]'); // OSC introducer, e.g. OSC-52 clipboard writes
  expect(output).not.toContain('\u009b'); // C1 CSI
  expect(output).not.toContain('\u001b['); // ESC-based CSI from server text
}
// Cursor moves (CSI n G) and erase-below (CSI 0 J) that node:readline writes
// while drawing its prompt. Deliberately narrow so a server-supplied CSI such
// as ESC[2J or ESC[31m still reaches the assertions above.
function stripReadlinePromptCodes(output: string): string {
  // eslint-disable-next-line no-control-regex -- matching the terminal bytes is the point
  return output.replace(/\u001b\[(?:\d*G|0J)/gu, '');
}

describe('elicitation responder', () => {
  it('attributes interactive form prompts and strips terminal control sequences from every display field', async () => {
    const request = {
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message: 'Confirm\u001b]52;c;Y2xpcGJvYXJk\u0007 request\nnow',
        requestedSchema: {
          type: 'object',
          properties: {
            target: {
              type: 'string',
              title: 'Tar\u001b[2Jget',
              description: 'Des\u009b2Jcription',
              enum: ['safe\u001b[31m-choice'],
              default: 'safe\u001b[31m-choice',
            },
          },
        },
      },
    } as ElicitRequest;

    const output = await captureInteractivePrompt(request, '\n', 'lin\u001b[2Jear');

    expect(output).toContain("Server 'linear' is requesting input:");
    expect(output).toContain('Confirm request now');
    expect(output).toContain('Description');
    expect(output).toContain('Choices: safe-choice');
    expect(output).toContain('Target [safe-choice]:');
    expectNoInjectedControlSequences(stripReadlinePromptCodes(output));
    expect(output).not.toContain('Y2xpcGJvYXJk');
    expect(output).not.toContain('[2J');
    expect(output).not.toContain('[31m');
  });

  it('strips terminal control sequences from elicitation URLs', async () => {
    const request = {
      method: 'elicitation/create',
      params: {
        mode: 'url',
        message: 'Authorize',
        url: 'https://example.com/\u001b]52;c;c2VjcmV0\u0007continue',
      },
    } as ElicitRequest;

    const output = await captureInteractivePrompt(request, '\n', 'linear');

    expect(output).toContain('https://example.com/continue');
    expectNoInjectedControlSequences(stripReadlinePromptCodes(output));
    expect(output).not.toContain('c2VjcmV0');
  });

  it('fulfils modern input_required results through the registered handler', async () => {
    const scripted: ElicitationHandler = vi.fn(async (request, context) => {
      expect(request.params).toMatchObject({ message: 'Where should this run?' });
      expect(context).toEqual({ server: 'fixture' });
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

async function captureInteractivePrompt(request: ElicitRequest, answer: string, server: string): Promise<string> {
  const input = new PassThrough();
  let outputText = '';
  const output = new Writable({
    write(chunk, _encoding, callback) {
      outputText += String(chunk);
      callback();
    },
  });
  const responder = createInteractiveElicitationResponder({ input, output });
  const pending = (
    responder.handler as unknown as (request: ElicitRequest, context: { server: string }) => Promise<unknown>
  )(request, { server });
  input.end(answer);
  await pending;
  return outputText;
}

function createClient(handler: ElicitationHandler, mode: 'legacy'): Client {
  const client = new Client(
    { name: 'mcporter-elicitation-test', version: '1.0.0' },
    {
      capabilities: { elicitation: { form: {}, url: {} } },
      versionNegotiation: { mode },
    }
  );
  registerElicitationHandler(client, handler, { server: 'fixture' });
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
