import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { ServerDefinition } from '../../src/config.js';
import { createBrowserRelayProof } from '../../src/browser-relay-auth-v2.js';
const STABLE_RELAY_TOKEN = 'a'.repeat(64);
export async function createRelayFixture(): Promise<{
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
