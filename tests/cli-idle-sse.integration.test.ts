import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createServer, type Server as HttpServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CLI_ENTRY = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const SINGLE_CONNECTION_FETCH = String.raw`
import http from 'node:http';
import { Readable } from 'node:stream';

const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });

globalThis.fetch = async (input, init = {}) => {
  const url = input instanceof URL ? input : new URL(input);
  if (url.protocol !== 'http:') {
    throw new TypeError('single-connection test fetch only supports http URLs');
  }
  const headers = Object.fromEntries(new Headers(init.headers));
  const body = init.body == null ? undefined : String(init.body);
  if (body !== undefined && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-length')) {
    headers['content-length'] = String(Buffer.byteLength(body));
  }

  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: init.method ?? 'GET', headers, agent }, (response) => {
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) responseHeaders.append(key, item);
        } else if (value !== undefined) {
          responseHeaders.set(key, String(value));
        }
      }
      resolve(new Response(Readable.toWeb(response), {
        status: response.statusCode ?? 502,
        statusText: response.statusMessage,
        headers: responseHeaders,
      }));
    });
    const abort = () => request.destroy(new DOMException('The operation was aborted.', 'AbortError'));
    init.signal?.addEventListener('abort', abort, { once: true });
    request.once('close', () => init.signal?.removeEventListener('abort', abort));
    request.once('error', reject);
    request.end(body);
  });
};
`;

interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
}

function runCli(args: string[], configPath: string, preloadPath: string): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [CLI_ENTRY, '--config', configPath, ...args],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          MCPORTER_NO_FORCE_EXIT: '1',
          NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}`,
        },
        maxBuffer: 1024 * 1024,
        timeout: 10_000,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

describe('idle standalone SSE CLI integration', () => {
  let httpServer: HttpServer;
  let idleResponse: ServerResponse | undefined;
  let configPath: string;
  let preloadPath: string;
  let tempDir: string;
  const requestOrder: string[] = [];
  let toolsListSawOpenSse = false;

  beforeAll(async () => {
    await fs.access(CLI_ENTRY);

    httpServer = createServer(async (request, response) => {
      if (request.method === 'GET') {
        requestOrder.push('GET standalone-sse');
        idleResponse = response;
        response.writeHead(200, {
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'content-type': 'text/event-stream',
        });
        response.flushHeaders();
        return;
      }

      let body = '';
      request.setEncoding('utf8');
      for await (const chunk of request) {
        body += chunk;
      }
      const message = JSON.parse(body) as { id?: number; method: string };
      requestOrder.push(message.method);

      if (message.method === 'initialize') {
        response.writeHead(200, {
          'content-type': 'application/json',
          'mcp-session-id': 'idle-sse-session',
        });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              capabilities: { tools: {} },
              protocolVersion: '2025-11-25',
              serverInfo: { name: 'idle-sse-test', version: '1.0.0' },
            },
          })
        );
        return;
      }

      if (message.method === 'notifications/initialized') {
        response.writeHead(202).end();
        return;
      }

      if (message.method === 'tools/list') {
        toolsListSawOpenSse = Boolean(idleResponse && !idleResponse.writableEnded && !idleResponse.destroyed);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              tools: [
                {
                  name: 'ping',
                  description: 'Return pong',
                  inputSchema: { type: 'object', properties: {} },
                },
              ],
            },
          })
        );
        return;
      }

      response.writeHead(404).end();
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', resolve);
    });
    const address = httpServer.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/mcp`;

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-idle-sse-'));
    configPath = path.join(tempDir, 'config.json');
    preloadPath = path.join(tempDir, 'single-connection-fetch.mjs');
    await fs.writeFile(configPath, JSON.stringify({ imports: [], mcpServers: { idle: { baseUrl } } }, null, 2), 'utf8');
    await fs.writeFile(preloadPath, SINGLE_CONNECTION_FETCH, 'utf8');
  });

  afterAll(async () => {
    idleResponse?.end();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('lists tools while a standalone SSE stream is open and byte-idle', async () => {
    const result = await runCli(['list', 'idle', '--json', '--timeout', '2000'], configPath, preloadPath);

    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toMatchObject({
      mode: 'server',
      name: 'idle',
      status: 'ok',
      tools: [expect.objectContaining({ name: 'ping' })],
    });
    expect(requestOrder).toEqual(['initialize', 'notifications/initialized', 'GET standalone-sse', 'tools/list']);
    expect(toolsListSawOpenSse).toBe(true);
  });
});
