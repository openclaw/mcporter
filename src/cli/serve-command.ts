import { DaemonClient } from '../daemon/client.js';
import { createKeepAliveRuntime } from '../daemon/runtime-wrapper.js';
import { isKeepAliveServer } from '../lifecycle.js';
import { createRuntime } from '../runtime.js';
import { DEFAULT_SERVE_HTTP_HOST, selectServedServers, serveHttp, serveStdio } from '../serve.js';

interface ServeCliOptions {
  readonly configPath: string;
  readonly configExplicit?: boolean;
  readonly rootDir?: string;
}

interface ParsedServeArgs {
  readonly mode: 'stdio' | 'http';
  readonly port?: number;
  readonly host?: string;
  readonly servers?: string[];
}

export async function handleServeCli(args: string[], options: ServeCliOptions): Promise<void> {
  const parsed = parseServeArgs(args);
  const baseRuntime = await createRuntime({
    configPath: options.configExplicit ? options.configPath : undefined,
    rootDir: options.rootDir,
  });
  const definitions = baseRuntime.getDefinitions();

  const keepAliveServers = new Set(definitions.filter(isKeepAliveServer).map((definition) => definition.name));
  let selectedServers: string[];
  try {
    const servedServers = selectServedServers(definitions, parsed.servers);
    selectedServers = servedServers.map((server) => server.name);
    if (selectedServers.length === 0) {
      throw new Error('No MCP servers are configured for keep-alive; nothing to serve.');
    }
  } catch (error) {
    await baseRuntime.close().catch(() => {});
    throw error;
  }

  const daemonClient = new DaemonClient({
    configPath: options.configPath,
    configExplicit: options.configExplicit,
    rootDir: options.rootDir,
  });
  const runtime = createKeepAliveRuntime(baseRuntime, {
    daemonClient,
    keepAliveServers,
  });

  if (parsed.mode === 'http') {
    let server: Awaited<ReturnType<typeof serveHttp>>;
    try {
      server = await serveHttp({
        runtime,
        definitions,
        servers: selectedServers,
        port: parsed.port ?? 0,
        host: parsed.host,
      });
    } catch (error) {
      await runtime.close().catch(() => {});
      throw error;
    }
    server.once('close', () => {
      void runtime.close().catch(() => {});
    });
    const address = server.address();
    const location =
      typeof address === 'object' && address
        ? `http://${address.address === '::' ? 'localhost' : address.address}:${address.port}/mcp`
        : 'listening';
    console.error(`MCPorter serve HTTP bridge ${location}`);
    return;
  }

  try {
    await serveStdio({
      runtime,
      definitions,
      servers: selectedServers,
    });
  } finally {
    await runtime.close().catch(() => {});
  }
}

export function printServeHelp(): void {
  console.log(`Usage: mcporter serve [--servers a,b,c] [--stdio | --http <port>]

Expose daemon-managed keep-alive MCP servers as one MCP server.

Flags:
  --servers <csv>  Restrict the bridge to the listed keep-alive server names.
  --stdio          Serve MCP over stdio (default).
  --http <port>    Serve MCP Streamable HTTP on /mcp.
  --host <host>    Host for --http (default: ${DEFAULT_SERVE_HTTP_HOST}).`);
}

export function parseServeArgs(args: string[]): ParsedServeArgs {
  let mode: 'stdio' | 'http' = 'stdio';
  let port: number | undefined;
  let host: string | undefined;
  let servers: string[] | undefined;
  let explicitStdio = false;
  let explicitHttp = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (!token) {
      continue;
    }
    if (token === '--stdio') {
      explicitStdio = true;
      mode = 'stdio';
      continue;
    }
    if (token === '--http') {
      explicitHttp = true;
      mode = 'http';
      const value = args[index + 1];
      if (!value) {
        throw new Error("Flag '--http' requires a port.");
      }
      port = parsePort(value);
      index += 1;
      continue;
    }
    if (token.startsWith('--http=')) {
      explicitHttp = true;
      mode = 'http';
      port = parsePort(token.slice('--http='.length));
      continue;
    }
    if (token === '--servers') {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Flag '--servers' requires a comma-separated list.");
      }
      servers = parseServerList(value);
      index += 1;
      continue;
    }
    if (token.startsWith('--servers=')) {
      servers = parseServerList(token.slice('--servers='.length));
      continue;
    }
    if (token === '--host') {
      const value = args[index + 1];
      if (!value) {
        throw new Error("Flag '--host' requires a value.");
      }
      host = value;
      index += 1;
      continue;
    }
    if (token.startsWith('--host=')) {
      host = token.slice('--host='.length);
      if (!host) {
        throw new Error("Flag '--host' requires a value.");
      }
      continue;
    }
    throw new Error(`Unknown serve flag '${token}'.`);
  }

  if (explicitStdio && explicitHttp) {
    throw new Error("Flags '--stdio' and '--http' cannot be used together.");
  }
  if (host && mode !== 'http') {
    throw new Error("Flag '--host' can only be used with '--http'.");
  }

  return { mode, port, host, servers };
}

function parsePort(value: string): number {
  if (value.trim().length === 0) {
    throw new Error("Flag '--http' requires a port.");
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error(`Invalid HTTP port '${value}'.`);
  }
  return port;
}

function parseServerList(value: string): string[] {
  const servers = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (servers.length === 0) {
    throw new Error("Flag '--servers' requires at least one server name.");
  }
  return servers;
}
