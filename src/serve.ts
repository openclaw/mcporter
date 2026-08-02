import http from 'node:http';
import { Readable } from 'node:stream';
import {
  createMcpHandler,
  McpServer,
  ProtocolError as McpError,
  ProtocolErrorCode as ErrorCode,
  type CallToolResult,
  type ListToolsResult,
  type ServerCapabilities,
  type Tool,
} from '@modelcontextprotocol/server';
import { serveStdio as serveMcpStdio } from '@modelcontextprotocol/server/stdio';
import type { ServerDefinition } from './config.js';
import { isKeepAliveServer } from './lifecycle.js';
import type { Runtime } from './runtime.js';
import { MCPORTER_VERSION } from './version.js';

export interface ServeOptions {
  readonly runtime: Pick<Runtime, 'listTools' | 'callTool'>;
  readonly definitions: readonly ServerDefinition[];
  readonly servers?: readonly string[];
  readonly bare?: boolean;
}

export interface ServeStdioOptions extends ServeOptions {}

export interface ServeHttpOptions extends ServeOptions {
  readonly port: number;
  readonly host?: string;
}

interface ServedServer {
  readonly name: string;
  readonly definition: ServerDefinition;
}

const TOOL_SEPARATOR = '__';
const DEFAULT_OBJECT_SCHEMA = { type: 'object' } as const;
export const DEFAULT_SERVE_HTTP_HOST = '127.0.0.1';

export async function serveStdio(options: ServeStdioOptions): Promise<void> {
  const handle = serveMcpStdio(() => createBridgeServer(options), {
    onerror: (error) => console.error(error),
  });
  await new Promise<void>((resolve, reject) => {
    process.stdin.once('end', () => {
      void handle.close().then(resolve, reject);
    });
    process.stdin.once('error', reject);
  });
}

export async function serveHttp(options: ServeHttpOptions): Promise<http.Server> {
  const handlers = new Map<string, ReturnType<typeof createMcpHandler>>();
  const handlerFor = (pathname: string, bridgeOptions: ServeOptions) => {
    const existing = handlers.get(pathname);
    if (existing) return existing;
    const handler = createMcpHandler(() => createBridgeServer(bridgeOptions));
    handlers.set(pathname, handler);
    return handler;
  };

  const httpServer = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${DEFAULT_SERVE_HTTP_HOST}`);
    let bridgeOptions: ServeOptions;
    if (url.pathname === '/mcp') {
      bridgeOptions = options;
    } else if (url.pathname.startsWith('/mcp/')) {
      let only: string;
      try {
        only = decodeURIComponent(url.pathname.slice('/mcp/'.length));
      } catch {
        response.writeHead(400).end('Bad request');
        return;
      }
      const known = selectServedServers(options.definitions, options.servers).some((served) => served.name === only);
      if (!known) {
        response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`Unknown server '${only}'`);
        return;
      }
      bridgeOptions = { ...options, servers: [only], bare: true };
    } else {
      response.writeHead(404).end('Not found');
      return;
    }
    const handler = handlerFor(url.pathname, bridgeOptions);
    void handleNodeRequest(handler, request, response).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      }
      response.end(message);
    });
  });
  httpServer.once('close', () => {
    for (const handler of handlers.values()) void handler.close().catch(() => {});
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port, options.host ?? DEFAULT_SERVE_HTTP_HOST, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  return httpServer;
}

export function createBridgeServer(options: ServeOptions): McpServer {
  const servedServers = selectServedServers(options.definitions, options.servers);
  const [firstServed] = servedServers;
  if (!firstServed) {
    throw new Error('No keep-alive MCP servers are available to serve.');
  }
  const bare = options.bare === true;
  if (bare && servedServers.length !== 1) {
    throw new Error('Bare serve mode requires exactly one served server.');
  }

  const server = new McpServer(
    { name: 'mcporter-serve', version: MCPORTER_VERSION },
    {
      capabilities: {
        tools: {},
      } satisfies ServerCapabilities,
      instructions: bare
        ? `MCPorter bridge exposing the '${firstServed.name}' server.`
        : 'MCPorter bridge exposing daemon-managed MCP servers. Tool names are namespaced as server__tool.',
    }
  );

  server.server.setRequestHandler('tools/list', async () => {
    const tools: Tool[] = [];
    for (const served of servedServers) {
      const listed = (await options.runtime.listTools(served.name, {
        includeSchema: true,
        autoAuthorize: true,
      })) as Array<{
        name: string;
        description?: string;
        inputSchema?: unknown;
        outputSchema?: unknown;
      }>;

      for (const tool of listed) {
        tools.push({
          name: bare ? tool.name : encodeToolName(served.name, tool.name),
          description: bare ? tool.description : describeTool(served.name, tool.description),
          inputSchema: normalizeInputSchema(tool.inputSchema),
          outputSchema: normalizeOutputSchema(tool.outputSchema),
        });
      }
    }
    return { tools } satisfies ListToolsResult;
  });

  server.server.setRequestHandler('tools/call', async (request) => {
    const target = bare
      ? { server: firstServed.name, tool: request.params.name }
      : decodeToolName(request.params.name, servedServers);
    if (!target) {
      throw new McpError(ErrorCode.InvalidParams, `Unknown bridged tool '${request.params.name}'.`);
    }
    const result = await options.runtime.callTool(target.server, target.tool, {
      args: request.params.arguments,
    });
    return result as CallToolResult;
  });

  return server;
}

async function handleNodeRequest(
  handler: ReturnType<typeof createMcpHandler>,
  request: http.IncomingMessage,
  response: http.ServerResponse
): Promise<void> {
  const webRequest = toWebRequest(request);
  const webResponse = await handler.fetch(webRequest);
  response.statusCode = webResponse.status;
  if (webResponse.statusText) response.statusMessage = webResponse.statusText;
  webResponse.headers.forEach((value, name) => response.setHeader(name, value));
  if (!webResponse.body) {
    response.end();
    return;
  }
  const body = Readable.fromWeb(webResponse.body as never);
  body.on('error', (error) => response.destroy(error));
  body.pipe(response);
}

function toWebRequest(request: http.IncomingMessage): Request {
  const host = request.headers.host ?? DEFAULT_SERVE_HTTP_HOST;
  const url = new URL(request.url ?? '/', `http://${host}`);
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) {
      for (const entry of value) headers.append(name, entry);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  const method = request.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const init: RequestInit & { duplex?: 'half' } = { method, headers };
  if (hasBody) {
    init.body = Readable.toWeb(request) as unknown as BodyInit;
    init.duplex = 'half';
  }
  return new Request(url, init);
}

export function selectServedServers(
  definitions: readonly ServerDefinition[],
  requested?: readonly string[]
): ServedServer[] {
  const keepAlive = definitions.filter(isKeepAliveServer);
  if (!requested || requested.length === 0) {
    return keepAlive.map((definition) => ({ name: definition.name, definition }));
  }

  const byName = new Map(keepAlive.map((definition) => [definition.name, definition]));
  return requested.map((name) => {
    const definition = byName.get(name);
    if (!definition) {
      throw new Error(`Server '${name}' is not configured for keep-alive and cannot be served by the daemon bridge.`);
    }
    return { name, definition };
  });
}

export function encodeToolName(server: string, tool: string): string {
  return `${encodeToolNamePart(server, { escapeTrailingUnderscore: true })}${TOOL_SEPARATOR}${encodeToolNamePart(tool, { escapeLeadingUnderscore: true })}`;
}

export function decodeToolName(
  name: string,
  servedServers: readonly Pick<ServedServer, 'name'>[]
): { server: string; tool: string } | undefined {
  const candidates = servedServers
    .map((served) => ({
      name: served.name,
      prefix: `${encodeToolNamePart(served.name, { escapeTrailingUnderscore: true })}${TOOL_SEPARATOR}`,
    }))
    .toSorted((first, second) => second.prefix.length - first.prefix.length);

  for (const candidate of candidates) {
    if (!name.startsWith(candidate.prefix)) {
      continue;
    }
    const tool = decodeToolNamePart(name.slice(candidate.prefix.length));
    if (tool.length === 0) {
      return undefined;
    }
    return { server: candidate.name, tool };
  }
  return undefined;
}

function encodeToolNamePart(
  value: string,
  options: { escapeLeadingUnderscore?: boolean; escapeTrailingUnderscore?: boolean } = {}
): string {
  let encoded = value.replaceAll('%', '%25').replaceAll(TOOL_SEPARATOR, '%5F%5F');
  if (options.escapeLeadingUnderscore && encoded.startsWith('_')) {
    encoded = `%5F${encoded.slice(1)}`;
  }
  if (options.escapeTrailingUnderscore && encoded.endsWith('_')) {
    encoded = `${encoded.slice(0, -1)}%5F`;
  }
  return encoded;
}

function decodeToolNamePart(value: string): string {
  return value.replaceAll('%5F', '_').replaceAll('%25', '%');
}

function describeTool(server: string, description: string | undefined): string | undefined {
  if (!description) {
    return `Tool from MCPorter server '${server}'.`;
  }
  return `[${server}] ${description}`;
}

function normalizeInputSchema(schema: unknown): Tool['inputSchema'] {
  if (isObjectSchema(schema)) {
    return schema;
  }
  return DEFAULT_OBJECT_SCHEMA;
}

function normalizeOutputSchema(schema: unknown): Tool['outputSchema'] {
  if (isObjectSchema(schema)) {
    return schema;
  }
  return undefined;
}

function isObjectSchema(schema: unknown): schema is Tool['inputSchema'] {
  if (!schema || typeof schema !== 'object') {
    return false;
  }
  return (schema as { type?: unknown }).type === 'object';
}
