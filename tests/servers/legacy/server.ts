import { randomUUID } from 'node:crypto';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  isInitializeRequest,
  ListToolsRequestSchema,
  McpError,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import express from 'express';
import { z } from 'zod';

const PAGE_SIZE = 25;
const TOUCH_URI = 'fixture://legacy/mutable';

interface ToolSpec {
  definition: Tool;
  run: (
    args: Record<string, unknown>,
    extra: {
      _meta?: { progressToken?: string | number };
      sendNotification(notification: {
        method: 'notifications/progress';
        params: { progressToken: string | number; progress: number; total?: number; message?: string };
      }): Promise<void>;
    }
  ) => CallToolResult | Promise<CallToolResult>;
}

function objectSchema(properties: Record<string, object> = {}, required: string[] = []) {
  return {
    type: 'object' as const,
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

export function createLegacyServer(): McpServer {
  const server = new McpServer(
    { name: 'mcporter-legacy-fixture', version: '1.0.0' },
    {
      capabilities: {
        logging: {},
        resources: { listChanged: true, subscribe: true },
        tools: { listChanged: true },
      },
      instructions: 'Deterministic MCP 2025-11-25 fixture covering the legacy protocol surface.',
    }
  );
  const tools = new Map<string, ToolSpec>();
  const subscriptions = new Set<string>();

  const addTool = (spec: ToolSpec) => tools.set(spec.definition.name, spec);

  addTool({
    definition: {
      name: 'echo',
      description: 'Return the supplied text unchanged.',
      inputSchema: objectSchema({ text: { type: 'string' } }, ['text']),
    },
    run: (args) => textResult(String(args.text)),
  });
  addTool({
    definition: {
      name: 'add',
      description: 'Add two numbers with structured output.',
      inputSchema: objectSchema({ a: { type: 'number' }, b: { type: 'number' } }, ['a', 'b']),
      outputSchema: objectSchema({ result: { type: 'number' } }, ['result']),
    },
    run: (args) => {
      const output = { result: Number(args.a) + Number(args.b) };
      return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
    },
  });
  addTool({
    definition: {
      name: 'long_task',
      description: 'Emit deterministic progress notifications before completing.',
      inputSchema: objectSchema({ steps: { type: 'integer', minimum: 1, maximum: 5, default: 3 } }),
    },
    run: async (args, extra) => {
      const steps = typeof args.steps === 'number' ? args.steps : 3;
      const progressToken = extra._meta?.progressToken;
      if (progressToken !== undefined) {
        for (let progress = 1; progress <= steps; progress += 1) {
          await extra.sendNotification({
            method: 'notifications/progress',
            params: { progressToken, progress, total: steps, message: `legacy step ${progress}/${steps}` },
          });
        }
      }
      return textResult(`legacy long task completed ${steps} steps`);
    },
  });
  addTool({
    definition: {
      name: 'log_spam',
      description: 'Emit logging notifications at several levels.',
      inputSchema: objectSchema(),
    },
    run: async () => {
      for (const level of ['debug', 'info', 'warning', 'error'] as const) {
        await server.sendLoggingMessage({ level, logger: 'legacy-fixture', data: `${level} fixture log` });
      }
      return textResult('emitted 4 log messages');
    },
  });
  addTool({
    definition: { name: 'fail', description: 'Return an MCP tool error result.', inputSchema: objectSchema() },
    run: () => ({ content: [{ type: 'text', text: 'legacy requested failure' }], isError: true }),
  });
  addTool({
    definition: { name: 'throw', description: 'Raise a JSON-RPC protocol error.', inputSchema: objectSchema() },
    run: () => {
      throw new McpError(ErrorCode.InternalError, 'legacy protocol error');
    },
  });
  addTool({
    definition: {
      name: 'annotated',
      title: 'Annotated Legacy Tool',
      description: 'Expose all stable 2025 tool annotations.',
      inputSchema: objectSchema(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    run: () => textResult('annotations are metadata'),
  });
  addTool({
    definition: {
      name: 'sample_poem',
      description: 'Ask the client to sample a short poem.',
      inputSchema: objectSchema(),
    },
    run: async () => {
      try {
        const sampled = await server.server.createMessage({
          maxTokens: 40,
          messages: [
            { role: 'user', content: { type: 'text', text: 'Write a two-line poem about deterministic tests.' } },
          ],
        });
        return textResult(`sampling result: ${JSON.stringify(sampled.content)}`);
      } catch {
        return textResult('sampling declined or unsupported by client');
      }
    },
  });
  addTool({
    definition: {
      name: 'elicit_name',
      description: 'Ask the client for a name using form elicitation.',
      inputSchema: objectSchema(),
    },
    run: async () => {
      try {
        const response = await server.server.elicitInput({
          mode: 'form',
          message: 'What name should the fixture greet?',
          requestedSchema: {
            type: 'object',
            properties: { name: { type: 'string', title: 'Name' } },
            required: ['name'],
          },
        });
        if (response.action !== 'accept') return textResult(`elicitation ${response.action}`);
        const name = typeof response.content?.name === 'string' ? response.content.name : 'unknown';
        return textResult(`hello ${name}`);
      } catch {
        return textResult('elicitation declined or unsupported by client');
      }
    },
  });
  addTool({
    definition: {
      name: 'touch_resource',
      description: 'Notify subscribers that the mutable resource changed.',
      inputSchema: objectSchema(),
    },
    run: async () => {
      if (subscriptions.has(TOUCH_URI)) await server.server.sendResourceUpdated({ uri: TOUCH_URI });
      return textResult('resource touched');
    },
  });
  let optionalToolEnabled = false;
  addTool({
    definition: {
      name: 'toggle_tool',
      description: 'Toggle a runtime-registered tool and emit list_changed.',
      inputSchema: objectSchema(),
    },
    run: async () => {
      optionalToolEnabled = !optionalToolEnabled;
      if (optionalToolEnabled) {
        addTool({
          definition: {
            name: 'runtime_tool',
            description: 'A dynamically registered fixture tool.',
            inputSchema: objectSchema(),
          },
          run: () => textResult('runtime tool enabled'),
        });
      } else {
        tools.delete('runtime_tool');
      }
      await server.server.sendToolListChanged();
      return textResult(`runtime tool ${optionalToolEnabled ? 'enabled' : 'disabled'}`);
    },
  });
  for (let index = 1; index <= 60; index += 1) {
    const name = `many_tools_${String(index).padStart(2, '0')}`;
    addTool({
      definition: { name, description: `Pagination fixture tool ${index}.`, inputSchema: objectSchema() },
      run: () => textResult(name),
    });
  }

  server.server.setRequestHandler(ListToolsRequestSchema, (request) => {
    const cursor = request.params?.cursor;
    const start = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
    if (!Number.isSafeInteger(start) || start < 0) throw new McpError(ErrorCode.InvalidParams, 'Invalid tools cursor');
    const definitions = [...tools.values()].map((tool) => tool.definition);
    const end = start + PAGE_SIZE;
    return { tools: definitions.slice(start, end), ...(end < definitions.length ? { nextCursor: String(end) } : {}) };
  });
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const spec = tools.get(request.params.name);
    if (!spec) throw new McpError(ErrorCode.InvalidParams, `Unknown tool '${request.params.name}'`);
    return await spec.run((request.params.arguments ?? {}) as Record<string, unknown>, extra);
  });
  server.server.setRequestHandler(SubscribeRequestSchema, (request) => {
    subscriptions.add(request.params.uri);
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, (request) => {
    subscriptions.delete(request.params.uri);
    return {};
  });

  server.registerResource(
    'welcome',
    'fixture://legacy/welcome',
    { title: 'Welcome text', description: 'Static UTF-8 fixture text.', mimeType: 'text/plain' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'hello from the legacy fixture' }] })
  );
  server.registerResource(
    'mutable',
    TOUCH_URI,
    { title: 'Mutable text', description: 'Resource used for subscription notifications.', mimeType: 'text/plain' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'legacy mutable resource' }] })
  );
  server.registerResource(
    'details',
    'fixture://legacy/details',
    { title: 'Fixture details', mimeType: 'application/json' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'application/json', text: '{"era":"legacy"}' }] })
  );
  server.registerResource(
    'binary',
    'fixture://legacy/binary',
    { title: 'Binary bytes', description: 'Small deterministic binary payload.', mimeType: 'application/octet-stream' },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/octet-stream',
          blob: Buffer.from([0, 1, 2, 253, 254, 255]).toString('base64'),
        },
      ],
    })
  );
  server.registerResource(
    'file',
    new ResourceTemplate('file:///{path}', {
      list: async () => ({ resources: [{ uri: 'file:///alpha.txt', name: 'alpha.txt', mimeType: 'text/plain' }] }),
      complete: {
        path: (value) => ['alpha.txt', 'beta.txt', 'notes/readme.md'].filter((path) => path.startsWith(value)),
      },
    }),
    { title: 'Virtual file', description: 'Template resource with path completion.', mimeType: 'text/plain' },
    async (uri, variables) => ({
      contents: [{ uri: uri.href, mimeType: 'text/plain', text: `legacy file ${String(variables.path)}` }],
    })
  );

  server.registerPrompt(
    'fixture_status',
    { title: 'Fixture status', description: 'A prompt without arguments.' },
    async () => ({
      messages: [{ role: 'user', content: { type: 'text', text: 'Describe the legacy fixture status.' } }],
    })
  );
  server.registerPrompt(
    'greet',
    {
      title: 'Greeting prompt',
      description: 'A prompt with a completable style argument.',
      argsSchema: {
        style: completable(z.string(), (value) =>
          ['brief', 'formal', 'playful'].filter((style) => style.startsWith(value))
        ),
        name: z.string(),
      },
    },
    async ({ style, name }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `Greet ${name} in a ${style} style.` } }],
    })
  );

  return server;
}

async function serveStdio(): Promise<void> {
  const server = createLegacyServer();
  await server.connect(new StdioServerTransport());
}

async function serveHttp(port: number): Promise<void> {
  const app = express();
  app.use(express.json());
  const sessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

  app.all('/mcp', async (request, response) => {
    try {
      const sessionId = request.headers['mcp-session-id'];
      let session = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;
      if (!session && request.method === 'POST' && isInitializeRequest(request.body)) {
        const server = createLegacyServer();
        let transport!: StreamableHTTPServerTransport;
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: randomUUID,
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            sessions.set(id, { transport, server });
          },
        });
        transport.onclose = () => {
          const id = transport.sessionId;
          if (id) sessions.delete(id);
        };
        await server.connect(transport);
        session = { transport, server };
      }
      if (!session) {
        response
          .status(400)
          .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Missing or invalid session' }, id: null });
        return;
      }
      await session.transport.handleRequest(request, response, request.body);
    } catch (error) {
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: error instanceof Error ? error.message : String(error) },
          id: null,
        });
      }
    }
  });

  const httpServer = app.listen(port, '127.0.0.1', () => {
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Legacy fixture did not bind a TCP port');
    console.error(`legacy fixture listening on http://127.0.0.1:${address.port}/mcp`);
  });
}

function parseMode(argv: string[]): { mode: 'stdio' } | { mode: 'http'; port: number } {
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--stdio')) return { mode: 'stdio' };
  if (argv[0] === '--http' && argv.length === 2) {
    const port = Number.parseInt(argv[1] ?? '', 10);
    if (Number.isInteger(port) && port >= 0 && port <= 65_535) return { mode: 'http', port };
  }
  throw new Error('Usage: server.ts [--stdio | --http <port>]');
}

const mode = parseMode(process.argv.slice(2));
if (mode.mode === 'stdio') await serveStdio();
else await serveHttp(mode.port);
