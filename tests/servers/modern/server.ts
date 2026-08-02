import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import {
  acceptedContent,
  CLIENT_INFO_META_KEY,
  createMcpHandler,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  McpServer,
  PROTOCOL_VERSION_META_KEY,
  ResourceTemplate,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { serveStdio as serveMcpStdio } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const confirmationSchema = z.object({ confirm: z.boolean() });
const requestStateCodec = createRequestStateCodec<{ operation: 'delete' }>({
  key: 'mcporter-modern-fixture-request-state-key',
  ttlSeconds: 300,
});
let runtimeToolEnabled = false;

export function createModernServer(notifyHttpToolsChanged?: () => void): McpServer {
  const server = new McpServer(
    { name: 'mcporter-modern-fixture', version: '1.0.0' },
    {
      capabilities: { tools: { listChanged: true } },
      instructions: 'Deterministic MCP 2026-07-28 fixture with the SDK legacy fallback enabled.',
      cacheHints: {
        'tools/list': { ttlMs: 1_000, cacheScope: 'private' },
        'resources/list': { ttlMs: 1_000, cacheScope: 'private' },
      },
      requestState: { verify: requestStateCodec.verify },
    }
  );

  server.registerTool(
    'echo',
    { description: 'Return the supplied text unchanged.', inputSchema: z.object({ text: z.string() }) },
    async ({ text }) => ({ content: [{ type: 'text', text }] })
  );
  server.registerTool(
    'add',
    {
      description: 'Add two numbers with structured output.',
      inputSchema: z.object({ a: z.number(), b: z.number() }),
      outputSchema: z.object({ result: z.number() }),
    },
    async ({ a, b }) => {
      const output = { result: a + b };
      return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
    }
  );
  server.registerTool(
    'long_task',
    {
      description: 'Emit progress on the modern response stream before completing.',
      inputSchema: z.object({ steps: z.number().int().min(1).max(5).default(3) }),
    },
    async ({ steps }, ctx) => {
      const progressToken = ctx.mcpReq._meta?.progressToken;
      if (progressToken !== undefined) {
        for (let progress = 1; progress <= steps; progress += 1) {
          await ctx.mcpReq.notify({
            method: 'notifications/progress',
            params: { progressToken, progress, total: steps, message: `modern step ${progress}/${steps}` },
          });
        }
      }
      return { content: [{ type: 'text', text: `modern long task completed ${steps} steps` }] };
    }
  );
  server.registerTool('fail', { description: 'Return an MCP tool error result.' }, async () => ({
    content: [{ type: 'text', text: 'modern requested failure' }],
    isError: true,
  }));
  server.registerTool(
    'confirm_delete',
    {
      description: 'Require a protected multi-round-trip confirmation before deleting.',
      inputSchema: z.object({ target: z.string().default('fixture-item') }),
    },
    async ({ target }, ctx) => confirmDelete(target, ctx)
  );
  server.registerTool(
    'whoami',
    { description: 'Return the per-request MCP client identity and protocol revision.' },
    async (ctx) => {
      const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
      const clientInfo = envelope?.[CLIENT_INFO_META_KEY] ?? server.server.getClientVersion();
      const protocolVersion = envelope?.[PROTOCOL_VERSION_META_KEY] ?? server.server.getNegotiatedProtocolVersion();
      const output = { clientInfo: clientInfo ?? null, protocolVersion: protocolVersion ?? null };
      return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output };
    }
  );

  let runtimeTool = runtimeToolEnabled ? registerRuntimeTool(server) : undefined;
  server.registerTool(
    'toggle_tool',
    { description: 'Toggle a runtime tool and notify modern listen streams.' },
    async () => {
      runtimeToolEnabled = !runtimeToolEnabled;
      if (runtimeToolEnabled && !runtimeTool) runtimeTool = registerRuntimeTool(server);
      if (!runtimeToolEnabled && runtimeTool) {
        runtimeTool.remove();
        runtimeTool = undefined;
      }
      notifyHttpToolsChanged?.();
      return { content: [{ type: 'text', text: `runtime tool ${runtimeToolEnabled ? 'enabled' : 'disabled'}` }] };
    }
  );

  server.registerResource(
    'welcome',
    'fixture://modern/welcome',
    {
      title: 'Modern welcome text',
      description: 'Static MCP 2026-07-28 fixture text.',
      mimeType: 'text/plain',
      cacheHint: { ttlMs: 1_000, cacheScope: 'private' },
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'hello from the modern fixture' }] })
  );
  server.registerResource(
    'document',
    new ResourceTemplate('fixture://modern/docs/{name}', {
      list: async () => ({
        resources: [{ uri: 'fixture://modern/docs/intro', name: 'intro', mimeType: 'text/plain' }],
      }),
      complete: { name: (value) => ['intro', 'reference'].filter((name) => name.startsWith(value)) },
    }),
    { title: 'Modern document', description: 'Template-backed modern resource.', mimeType: 'text/plain' },
    async (uri, variables) => ({
      contents: [{ uri: uri.href, mimeType: 'text/plain', text: `modern document ${String(variables.name)}` }],
    })
  );
  server.registerPrompt(
    'summarize_fixture',
    { title: 'Summarize fixture', description: 'One modern fixture prompt.' },
    async () => ({
      messages: [{ role: 'user', content: { type: 'text', text: 'Summarize the MCP 2026-07-28 fixture.' } }],
    })
  );

  return server;
}

async function confirmDelete(target: string, ctx: ServerContext) {
  const response = inputResponse(ctx.mcpReq.inputResponses, 'confirmation');
  const state = ctx.mcpReq.requestState<{ operation: 'delete' }>();
  if (!state || response.kind === 'missing') {
    return inputRequired({
      inputRequests: {
        confirmation: inputRequired.elicit({
          message: `Delete ${target}?`,
          requestedSchema: confirmationSchema,
        }),
      },
      requestState: await requestStateCodec.mint({ operation: 'delete' }, ctx),
    });
  }
  if (state.operation !== 'delete') throw new Error('Unexpected confirmation request state');
  if (response.kind !== 'elicit' || response.action !== 'accept') {
    return { content: [{ type: 'text' as const, text: `delete declined for ${target}` }] };
  }
  const accepted = acceptedContent(ctx.mcpReq.inputResponses, 'confirmation', confirmationSchema);
  if (accepted?.confirm !== true) {
    return { content: [{ type: 'text' as const, text: `delete declined for ${target}` }] };
  }
  return { content: [{ type: 'text' as const, text: `deleted ${target}` }] };
}

function registerRuntimeTool(server: McpServer) {
  return server.registerTool(
    'runtime_tool',
    { description: 'A dynamically registered modern fixture tool.' },
    async () => ({
      content: [{ type: 'text', text: 'runtime tool enabled' }],
    })
  );
}

function serveStdio(): void {
  serveMcpStdio(() => createModernServer());
}

async function serveHttp(port: number): Promise<void> {
  let publishToolsChanged: (() => void) | undefined;
  const handler = createMcpHandler(() => createModernServer(() => publishToolsChanged?.()));
  publishToolsChanged = () => handler.notify.toolsChanged();
  const httpServer = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    if (url.pathname !== '/mcp') {
      response.writeHead(404).end('Not found');
      return;
    }
    void handler
      .fetch(toWebRequest(request))
      .then((webResponse) => writeWebResponse(response, webResponse))
      .catch((error: unknown) => {
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        response.end(error instanceof Error ? error.message : String(error));
      });
  });
  httpServer.once('close', () => void handler.close());
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  const address = httpServer.address();
  if (!address || typeof address === 'string') throw new Error('Modern fixture did not bind a TCP port');
  console.error(`modern fixture listening on http://127.0.0.1:${address.port}/mcp`);
}

function toWebRequest(request: import('node:http').IncomingMessage): Request {
  const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const entry of value) headers.append(name, entry);
    else if (value !== undefined) headers.set(name, value);
  }
  const method = request.method ?? 'GET';
  const init: RequestInit & { duplex?: 'half' } = { method, headers };
  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(request) as unknown as BodyInit;
    init.duplex = 'half';
  }
  return new Request(url, init);
}

function writeWebResponse(response: import('node:http').ServerResponse, webResponse: Response): void {
  response.statusCode = webResponse.status;
  webResponse.headers.forEach((value, name) => response.setHeader(name, value));
  if (!webResponse.body) {
    response.end();
    return;
  }
  const body = Readable.fromWeb(webResponse.body as never);
  body.on('error', (error) => response.destroy(error));
  body.pipe(response);
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
if (mode.mode === 'stdio') serveStdio();
else await serveHttp(mode.port);
