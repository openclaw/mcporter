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

  it('validates every primitive form field before returning typed content', async () => {
    const request = {
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message: 'Configure deployment',
        requestedSchema: {
          type: 'object',
          required: ['confirm', 'count', 'tags', 'mode'],
          properties: {
            confirm: { type: 'boolean', title: 'Confirm' },
            count: { type: 'integer', minimum: 1, maximum: 3 },
            tags: {
              type: 'array',
              items: {
                anyOf: [
                  { const: 'a', title: 'A' },
                  { const: 'b', title: 'B' },
                ],
              },
            },
            mode: { type: 'string', oneOf: [{ const: 'fast' }, { const: 'safe' }] },
            label: { type: 'string', minLength: 2, maxLength: 4, default: 'demo' },
            note: { type: 'string' },
          },
        },
      },
    } as ElicitRequest;

    const { output, result, responder } = await captureInteractiveResult(
      request,
      'maybe\ny\n1.5\n0\n4\n2\na,x\na,b\nbad\nfast\n\n\n',
      'fixture'
    );

    expect(result).toEqual({
      action: 'accept',
      content: { confirm: true, count: 2, tags: ['a', 'b'], mode: 'fast', label: 'demo' },
    });
    expect(responder.didDecline()).toBe(false);
    expect(output).toContain('Enter yes/no or true/false.');
    expect(output).toContain('Enter a valid integer.');
    expect(output).toContain('greater than or equal to 1');
    expect(output).toContain('less than or equal to 3');
    expect(output).toContain('Choose comma-separated values from: a, b.');
    expect(output).toContain('Choose one of: fast, safe.');
  });

  it('re-prompts required and bounded strings and accepts false and decimal values', async () => {
    const request = {
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message: 'More values',
        requestedSchema: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 2, maxLength: 4 },
            enabled: { type: 'boolean' },
            ratio: { type: 'number' },
            colors: { type: 'array', items: { type: 'string', enum: ['red', 'blue'] } },
          },
        },
      },
    } as ElicitRequest;

    const { output, result } = await captureInteractiveResult(
      request,
      '\nx\ntoolong\nok\nfalse\n2.5\nred, blue\n',
      'fixture'
    );

    expect(result).toEqual({
      action: 'accept',
      content: { name: 'ok', enabled: false, ratio: 2.5, colors: ['red', 'blue'] },
    });
    expect(output).toContain('name is required.');
    expect(output).toContain('Enter at least 2 characters.');
    expect(output).toContain('Enter no more than 4 characters.');
  });

  it('marks interrupted form and URL prompts as declined', async () => {
    const form = {
      method: 'elicitation/create',
      params: {
        mode: 'form',
        message: 'Need a value',
        requestedSchema: {
          type: 'object',
          properties: { required: { type: 'string' } },
          required: ['required'],
        },
      },
    } as ElicitRequest;
    const url = {
      method: 'elicitation/create',
      params: { mode: 'url', message: 'Authorize', url: 'https://example.com/auth' },
    } as ElicitRequest;

    const formResult = await captureInteractiveResult(form, '', 'fixture');
    const urlResult = await captureInteractiveResult(url, '', 'fixture');

    expect(formResult.result).toEqual({ action: 'decline' });
    expect(formResult.responder.didDecline()).toBe(true);
    expect(urlResult.result).toEqual({ action: 'decline' });
    expect(urlResult.responder.didDecline()).toBe(true);
  });
});

async function captureInteractivePrompt(request: ElicitRequest, answer: string, server: string): Promise<string> {
  return (await captureInteractiveResult(request, answer, server)).output;
}

async function captureInteractiveResult(
  request: ElicitRequest,
  answer: string,
  server: string
): Promise<{ output: string; result: unknown; responder: ReturnType<typeof createInteractiveElicitationResponder> }> {
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
  const feedAnswers = async () => {
    if (answer.length === 0) {
      input.end();
      return;
    }
    const lines = answer.match(/.*\n|.+$/gu) ?? [];
    for (const line of lines) {
      input.write(line);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    input.end();
  };
  const [result] = await Promise.all([pending, feedAnswers()]);
  return { output: outputText, result, responder };
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
