import { Client, SdkError, SdkErrorCode, type Transport } from '@modelcontextprotocol/client';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHROME_RELAY_HANDOFF_ENV } from '../src/chrome-devtools-relay-handoff.js';
import { createBrowserRelayProof } from '../src/browser-relay-auth-v2.js';
import type { ServerDefinition } from '../src/config.js';
import { createClientContext } from '../src/runtime/transport.js';
import { clientInfo, createLogger, resetLogger } from './helpers/runtime-test-helpers.js';

const STABLE_RELAY_TOKEN = 'a'.repeat(64);
const logger = createLogger();

beforeEach(() => resetLogger(logger));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('runtime Chrome relay handoff lifecycle', () => {
  it('keeps both credentials out of spawn args and cleans the first handoff before negotiation retry', async () => {
    const fixture = await createRelayFixture();
    const attempts: SpawnShape[] = [];
    vi.spyOn(Client.prototype, 'connect')
      .mockImplementationOnce(async (transport) => {
        attempts.push(await inspectSpawnShape(transport));
        throw new SdkError(SdkErrorCode.EraNegotiationFailed, 'fixture requests legacy retry');
      })
      .mockImplementationOnce(async (transport) => {
        attempts.push(await inspectSpawnShape(transport));
      });

    try {
      const context = await createClientContext(fixture.definition, logger, clientInfo);
      expect(attempts).toHaveLength(2);
      await vi.waitFor(() => expect(fixture.activeConnections).toBe(1));
      assertCredentialFreeSpawn(attempts[0]!);
      assertCredentialFreeSpawn(attempts[1]!);
      await expect(fs.stat(attempts[0]!.handoffPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(connect(attempts[0]!.port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      await expect(fs.stat(attempts[1]!.handoffPath)).resolves.toBeDefined();

      await context.transport.close();
      await expect(fs.stat(attempts[1]!.handoffPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(connect(attempts[1]!.port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    } finally {
      await fixture.close();
      await fs.rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('cleans the proxy and protected handoff when connection setup is aborted', async () => {
    const fixture = await createRelayFixture();
    const controller = new AbortController();
    controller.abort();
    let attempt: SpawnShape | undefined;
    vi.spyOn(Client.prototype, 'connect').mockImplementationOnce(async (transport) => {
      attempt = await inspectSpawnShape(transport);
      throw new DOMException('aborted', 'AbortError');
    });

    try {
      await expect(
        createClientContext(fixture.definition, logger, clientInfo, { signal: controller.signal })
      ).rejects.toThrow('aborted');
      expect(attempt).toBeDefined();
      await expect(fs.stat(attempt!.handoffPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(connect(attempt!.port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    } finally {
      await fixture.close();
      await fs.rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('cleans relay resources when transport wrapping fails before child start', async () => {
    const fixture = await createRelayFixture();
    let handoffPath: string | undefined;
    let port: number | undefined;
    try {
      await expect(
        createClientContext(fixture.definition, logger, clientInfo, {
          onTransportCreated: (transport) => {
            const params = (
              transport as unknown as {
                _serverParams: { args?: readonly string[]; env?: Record<string, string> };
              }
            )._serverParams;
            handoffPath = params.env?.[CHROME_RELAY_HANDOFF_ENV];
            const endpoint = params.args?.at(-1);
            port = endpoint ? Number(new URL(endpoint).port) : undefined;
            throw new Error('fixture wrapping failure');
          },
        })
      ).rejects.toThrow('fixture wrapping failure');
      expect(handoffPath).toBeDefined();
      expect(port).toBeTypeOf('number');
      await expect(fs.stat(handoffPath!)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(connect(port!)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    } finally {
      await fixture.close();
      await fs.rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('falls back to legacy for prefer but fails closed for require when protected handoff setup fails', async () => {
    const fixture = await createRelayFixture();
    const blocker = path.join(fixture.directory, 'not-a-directory');
    await fs.writeFile(blocker, 'block');
    vi.spyOn(os, 'tmpdir').mockReturnValue(blocker);
    let preferredArgs: readonly string[] = [];
    const connectSpy = vi.spyOn(Client.prototype, 'connect').mockImplementationOnce(async (transport) => {
      preferredArgs =
        (
          transport as unknown as {
            _serverParams: { args?: readonly string[]; env?: Record<string, string> };
          }
        )._serverParams.args ?? [];
    });

    try {
      const preferred = await createClientContext(fixture.definition, logger, clientInfo);
      expect(preferredArgs).toContain('--autoConnect');
      expect(preferredArgs).not.toContain('--wsEndpoint');
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('"route":"legacy"'));
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('"reason":"handoff-error"'));
      await preferred.transport.close();

      const requiredDefinition: ServerDefinition = { ...fixture.definition, chromeDevtoolsRelay: 'require' };
      await expect(createClientContext(requiredDefinition, logger, clientInfo)).rejects.toMatchObject({
        name: 'ChromeDevtoolsRelayRequiredError',
        decision: expect.objectContaining({ route: 'unavailable', reason: 'handoff-error', policy: 'require' }),
      });
      expect(connectSpy).toHaveBeenCalledOnce();
    } finally {
      await fixture.close();
      await fs.rm(fixture.directory, { recursive: true, force: true });
    }
  });
});

interface SpawnShape {
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  readonly ephemeralAuthorization: string;
  readonly handoffPath: string;
  readonly port: number;
}

async function createRelayFixture(): Promise<{
  directory: string;
  definition: ServerDefinition;
  readonly activeConnections: number;
  close(): Promise<void>;
}> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-runtime-relay-'));
  await fs.writeFile(path.join(directory, 'browser-extension-relay.secret'), STABLE_RELAY_TOKEN, { mode: 0o600 });
  const key = Buffer.from(STABLE_RELAY_TOKEN, 'hex');
  const states = new WeakMap<net.Socket, ReturnType<typeof createChallengeFields>>();
  const relaySockets = new Set<net.Socket>();
  const server = http.createServer(async (request, response) => {
    const socket = request.socket;
    if (request.url === '/_openclaw/relay/auth/v2/challenge') {
      const body = await readRequestJson(request);
      const fields = createChallengeFields(String(body.keyId), String(body.clientNonce));
      states.set(socket, fields);
      writeResponseJson(response, {
        type: 'auth.challenge',
        v: 2,
        ...fields,
        serverProof: createBrowserRelayProof(key, 'server', fields),
      });
      return;
    }
    if (request.url === '/_openclaw/relay/auth/v2/complete') {
      const body = await readRequestJson(request);
      const fields = states.get(socket);
      if (!fields) {
        response.writeHead(412).end();
        return;
      }
      writeResponseJson(response, {
        type: 'auth.ok',
        v: 2,
        sessionId: fields.sessionId,
        acceptProof: createBrowserRelayProof(key, 'accept', fields, String(body.clientProof)),
      });
      return;
    }
    if (request.url === '/json/version' && states.has(socket)) {
      writeResponseJson(response, { Browser: 'OpenClaw' });
      return;
    }
    response.writeHead(404, { 'Content-Length': '0' }).end();
  });
  server.on('connection', (socket) => {
    relaySockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => relaySockets.delete(socket));
  });
  server.on('upgrade', (request, socket) => {
    const relaySocket = socket as net.Socket;
    if (request.url !== '/cdp' || !states.has(relaySocket)) {
      relaySocket.destroy();
      return;
    }
    const websocketKey = String(request.headers['sec-websocket-key'] ?? '');
    const accept = createHash('sha1').update(`${websocketKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    relaySocket.write(
      `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const relayPort = (server.address() as net.AddressInfo).port;
  return {
    directory,
    definition: {
      name: 'chrome-devtools',
      command: {
        kind: 'stdio',
        command: 'npx',
        args: ['-y', 'chrome-devtools-mcp@latest', '--autoConnect'],
        cwd: directory,
      },
      env: {
        OPENCLAW_OAUTH_DIR: directory,
        NODE_OPTIONS: '--trace-warnings',
        MCPORTER_CHROME_DEVTOOLS_RELAY_URL: `http://127.0.0.1:${relayPort}`,
      },
    },
    get activeConnections() {
      return relaySockets.size;
    },
    async close() {
      for (const socket of relaySockets) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function createChallengeFields(keyId: string, clientNonce: string) {
  const now = Date.now();
  return {
    keyId,
    instanceId: Buffer.from('instance-id-0001').toString('base64url'),
    sessionId: Buffer.from('session-id-00001').toString('base64url'),
    clientNonce,
    serverNonce: Buffer.alloc(32, 0x42).toString('base64url'),
    issuedAtMs: now,
    expiresAtMs: now + 10_000,
    role: 'cdp',
    transport: 'connection',
    method: 'SEQUENCE',
    resource: '/json/version -> /cdp',
    flow: 'cdp',
  } as const;
}

async function readRequestJson(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

function writeResponseJson(response: http.ServerResponse, body: Record<string, unknown>): void {
  const encoded = Buffer.from(JSON.stringify(body));
  response.writeHead(200, {
    'Content-Type': 'application/json',
    'Content-Length': encoded.byteLength,
    Connection: 'keep-alive',
  });
  response.end(encoded);
}

async function inspectSpawnShape(transport: Transport): Promise<SpawnShape> {
  const params = (
    transport as unknown as {
      _serverParams: { args?: readonly string[]; env?: Record<string, string> };
    }
  )._serverParams;
  const args = params.args ?? [];
  const env = params.env ?? {};
  const handoffPath = env[CHROME_RELAY_HANDOFF_ENV];
  if (!handoffPath) throw new Error('missing test handoff path');
  const payload = JSON.parse(await fs.readFile(handoffPath, 'utf8')) as { Authorization?: string };
  if (!payload.Authorization) throw new Error('missing test authorization');
  const endpoint = args.at(-1);
  if (!endpoint) throw new Error('missing test endpoint');
  return {
    args,
    env,
    ephemeralAuthorization: payload.Authorization,
    handoffPath,
    port: Number(new URL(endpoint).port),
  };
}

function assertCredentialFreeSpawn(shape: SpawnShape): void {
  const renderedArgs = shape.args.join('\0');
  expect(renderedArgs).not.toContain(STABLE_RELAY_TOKEN);
  expect(JSON.stringify(shape.env)).not.toContain(STABLE_RELAY_TOKEN);
  expect(renderedArgs).not.toContain(shape.ephemeralAuthorization);
  expect(JSON.stringify(shape.env)).not.toContain(shape.ephemeralAuthorization);
  expect(shape.args).not.toContain('--wsHeaders');
  expect(shape.args.at(-1)).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/cdp$/u);
  expect(shape.env[CHROME_RELAY_HANDOFF_ENV]).toBe(shape.handoffPath);
  expect(shape.env.NODE_OPTIONS).toContain('--trace-warnings');
  expect(shape.env.NODE_OPTIONS).toContain('--import=file://');
  expect(shape.env[CHROME_RELAY_HANDOFF_ENV]).not.toContain(shape.ephemeralAuthorization);
}

async function connect(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('error', reject);
  });
}
