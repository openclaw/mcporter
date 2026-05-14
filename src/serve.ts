import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
  type CallToolResult,
  type ListToolsResult,
  type ServerCapabilities,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type { ServerDefinition } from './config.js';
import { isKeepAliveServer } from './lifecycle.js';
import type { Runtime } from './runtime.js';
import { MCPORTER_VERSION } from './version.js';

export interface ServeOptions {
  readonly runtime: Pick<Runtime, 'listTools' | 'callTool'>;
  readonly definitions: readonly ServerDefinition[];
  readonly servers?: readonly string[];
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
  const server = createBridgeServer(options);
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve, reject) => {
    transport.onclose = () => resolve();
    transport.onerror = (error) => reject(error);
  });
  await server.connect(transport);
  await closed;
}

export async function serveHttp(options: ServeHttpOptions): Promise<http.Server> {
  const httpServer = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://${DEFAULT_SERVE_HTTP_HOST}`);
    if (url.pathname !== '/mcp') {
      response.writeHead(404).end('Not found');
      return;
    }
    const bridgeServer = createBridgeServer(options);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    response.on('close', () => {
      void transport.close().catch(() => {});
      void bridgeServer.close().catch(() => {});
    });
    void (async () => {
      await bridgeServer.connect(transport);
      await transport.handleRequest(request, response);
    })().catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      }
      response.end(message);
    });
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
  if (servedServers.length === 0) {
    throw new Error('No keep-alive MCP servers are available to serve.');
  }

  const server = new McpServer(
    { name: 'mcporter-serve', version: MCPORTER_VERSION },
    {
      capabilities: {
        tools: {},
      } satisfies ServerCapabilities,
      instructions: 'MCPorter bridge exposing daemon-managed MCP servers. Tool names are namespaced as server__tool.',
    }
  );

  server.server.setRequestHandler(ListToolsRequestSchema, async () => {
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
          name: encodeToolName(served.name, tool.name),
          description: describeTool(served.name, tool.description),
          inputSchema: normalizeInputSchema(tool.inputSchema),
          outputSchema: normalizeOutputSchema(tool.outputSchema),
        });
      }
    }
    return { tools } satisfies ListToolsResult;
  });

  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const target = decodeToolName(request.params.name, servedServers);
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
  return `${server}${TOOL_SEPARATOR}${tool}`;
}

export function decodeToolName(
  name: string,
  servedServers: readonly Pick<ServedServer, 'name'>[]
): { server: string; tool: string } | undefined {
  const sorted = [...servedServers].toSorted((a, b) => b.name.length - a.name.length);
  for (const server of sorted) {
    const prefix = `${server.name}${TOOL_SEPARATOR}`;
    if (name.startsWith(prefix)) {
      const tool = name.slice(prefix.length);
      if (tool.length > 0) {
        return { server: server.name, tool };
      }
    }
  }
  return undefined;
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
