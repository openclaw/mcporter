import { createHash } from 'node:crypto';
import net, { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createBrowserRelayProof, deriveBrowserRelayKeyId } from '../src/browser-relay-auth-v2.js';
import {
  connectChromeDevtoolsRelayV2,
  type ChromeDevtoolsRelayCredential,
} from '../src/chrome-devtools-relay-client.js';

const KEY_HEX = '0123456789abcdef'.repeat(4);
const KEY = Buffer.from(KEY_HEX, 'hex');
const CREDENTIAL: ChromeDevtoolsRelayCredential = { key: KEY, keyId: deriveBrowserRelayKeyId(KEY) };
const INSTANCE_ID = Buffer.from('instance-id-0001').toString('base64url');
const SESSION_ID = Buffer.from('session-id-00001').toString('base64url');
const SERVER_NONCE = Buffer.alloc(32, 0x5a).toString('base64url');
const servers = new Set<net.Server>();
const sockets = new Set<net.Socket>();

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) return resolve();
          server.close(() => resolve());
        })
    )
  );
  servers.clear();
});

describe('Browser Relay Authentication v2 raw CDP client', () => {
  it('authenticates challenge, probe, and upgrade on one socket without legacy credentials', async () => {
    const relay = await createValidRelay();
    const result = await connect(relay.port);
    expect(result).toMatchObject({ reason: 'success', status: 200, upstream: { head: expect.any(Buffer) } });
    expect(relay.connectionCount).toBe(1);
    expect(relay.requests.map((request) => request.path)).toEqual([
      '/_openclaw/relay/auth/v2/challenge',
      '/_openclaw/relay/auth/v2/complete',
      '/json/version',
      '/cdp',
    ]);
    const capture = relay.requests.map((request) => request.raw).join('\n');
    expect(capture).not.toMatch(/authorization:/iu);
    expect(capture).not.toMatch(/\bbasic\b/iu);
    expect(capture).not.toMatch(/\bbearer\b/iu);
    expect(capture).not.toContain(KEY_HEX);
    expect(relay.requests[0]?.body).toMatchObject({
      v: 2,
      keyId: CREDENTIAL.keyId,
      role: 'cdp',
      transport: 'connection',
      method: 'SEQUENCE',
      resource: '/json/version -> /cdp',
      flow: 'cdp',
    });
    result.upstream?.socket.destroy();
  });

  it('authenticates one json-list request on the same socket and then closes', async () => {
    const relay = await createValidRelay({ flow: 'json-list' });
    const result = await connect(relay.port, undefined, 'json-list');
    expect(result).toMatchObject({ reason: 'success', status: 200, json: [{ id: 'target-1' }] });
    expect(result.upstream).toBeUndefined();
    expect(relay.connectionCount).toBe(1);
    expect(relay.requests.map((request) => request.path)).toEqual([
      '/_openclaw/relay/auth/v2/challenge',
      '/_openclaw/relay/auth/v2/complete',
      '/json/list',
    ]);
    expect(relay.requests[0]?.body).toMatchObject({
      method: 'GET',
      resource: '/json/list',
      flow: 'json-list',
    });
  });

  it('sends no client proof after a forged server proof', async () => {
    const relay = await createValidRelay({
      mutateChallenge: (challenge) => ({ ...challenge, serverProof: 'A'.repeat(43) }),
    });
    const result = await connect(relay.port);
    expect(result.reason).toBe('bad-server-proof');
    expect(relay.requests.map((request) => request.path)).toEqual(['/_openclaw/relay/auth/v2/challenge']);
    expect(relay.requests[0]?.raw).not.toContain('clientProof');
  });

  it.each(['type', 'sessionId', 'serverProof'])('rejects a challenge missing required %s', async (field) => {
    const relay = await createValidRelay({
      mutateChallenge: (challenge) => omitField(challenge, field),
    });
    const result = await connect(relay.port);
    expect(result.reason).toBe('protocol');
    expect(relay.requests.map((request) => request.path)).toEqual(['/_openclaw/relay/auth/v2/challenge']);
    expect(relay.requests[0]?.raw).not.toContain('clientProof');
  });

  it.each([
    ['keyId', (value: Record<string, unknown>) => ({ ...value, keyId: 'A'.repeat(22) }), 'protocol'],
    ['client nonce', (value: Record<string, unknown>) => ({ ...value, clientNonce: 'B'.repeat(43) }), 'protocol'],
    [
      'session',
      (value: Record<string, unknown>) => ({ ...value, sessionId: Buffer.alloc(16, 0x43).toString('base64url') }),
      'bad-server-proof',
    ],
    [
      'instance',
      (value: Record<string, unknown>) => ({ ...value, instanceId: Buffer.alloc(16, 0x44).toString('base64url') }),
      'bad-server-proof',
    ],
    [
      'server nonce',
      (value: Record<string, unknown>) => ({ ...value, serverNonce: 'E'.repeat(43) }),
      'bad-server-proof',
    ],
    ['role', (value: Record<string, unknown>) => ({ ...value, role: 'extension' }), 'protocol'],
    ['transport', (value: Record<string, unknown>) => ({ ...value, transport: 'websocket' }), 'protocol'],
    ['method', (value: Record<string, unknown>) => ({ ...value, method: 'GET' }), 'protocol'],
    ['resource', (value: Record<string, unknown>) => ({ ...value, resource: '/cdp' }), 'protocol'],
    ['flow', (value: Record<string, unknown>) => ({ ...value, flow: 'json-list' }), 'protocol'],
    ['version', (value: Record<string, unknown>) => ({ ...value, v: 1 }), 'protocol'],
  ] as const)('rejects a challenge with the wrong %s', async (_label, mutate, expected) => {
    const relay = await createValidRelay({ mutateChallenge: mutate });
    const result = await connect(relay.port);
    expect(result.reason).toBe(expected);
    expect(relay.requests).toHaveLength(1);
  });

  it('rejects expired and overlong challenges before sending a proof', async () => {
    for (const timestamps of [
      { issuedAtMs: 1, expiresAtMs: 10_001 },
      { issuedAtMs: 50_000, expiresAtMs: 60_001 },
    ]) {
      const relay = await createValidRelay({
        now: 50_000,
        mutateChallenge: (challenge) => {
          const fields = { ...challengeFields(challenge), ...timestamps };
          return { ...challenge, ...timestamps, serverProof: createBrowserRelayProof(KEY, 'server', fields) };
        },
      });
      const result = await connect(relay.port, 50_000);
      expect(result.reason).toBe('freshness');
      expect(relay.requests).toHaveLength(1);
    }
  });

  it('rejects a challenge one millisecond after expiry without applying clock skew', async () => {
    const relay = await createValidRelay({
      mutateChallenge: (challenge) => {
        const timestamps = { issuedAtMs: 40_000, expiresAtMs: 50_000 };
        const fields = { ...challengeFields(challenge), ...timestamps };
        return { ...challenge, ...timestamps, serverProof: createBrowserRelayProof(KEY, 'server', fields) };
      },
    });
    const result = await connect(relay.port, 50_001);
    expect(result.reason).toBe('freshness');
    expect(relay.requests.map((request) => request.path)).toEqual(['/_openclaw/relay/auth/v2/challenge']);
    expect(relay.requests[0]?.raw).not.toContain('clientProof');
  });

  it('verifies the accept proof and classifies only authenticated 503 as extension-disconnected', async () => {
    const badAccept = await createValidRelay({ badAcceptProof: true });
    expect((await connect(badAccept.port)).reason).toBe('bad-server-proof');
    expect(badAccept.requests.map((request) => request.path)).toEqual([
      '/_openclaw/relay/auth/v2/challenge',
      '/_openclaw/relay/auth/v2/complete',
    ]);

    const signed503 = await createValidRelay({ versionStatus: 503 });
    expect(await connect(signed503.port)).toMatchObject({ reason: 'extension-disconnected', status: 503 });

    const unsigned503 = await createRawFirstResponse('HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n');
    expect(await connect(unsigned503.port)).toMatchObject({ reason: 'server-auth-failed', status: 503 });
  });

  it.each(['type', 'sessionId', 'acceptProof'])('rejects auth.ok missing required %s', async (field) => {
    const relay = await createValidRelay({
      mutateAccept: (accepted) => omitField(accepted, field),
    });
    const result = await connect(relay.port);
    expect(result.reason).toBe('protocol');
    expect(relay.requests.map((request) => request.path)).toEqual([
      '/_openclaw/relay/auth/v2/challenge',
      '/_openclaw/relay/auth/v2/complete',
    ]);
  });

  it.each([
    [401, 'unsupported-auth'],
    [404, 'unsupported-auth'],
    [426, 'unsupported-auth'],
    [408, 'freshness'],
    [410, 'freshness'],
    [409, 'sequence'],
    [412, 'sequence'],
    [400, 'protocol'],
  ] as const)('classifies an unauthenticated %i without retrying legacy auth', async (status, reason) => {
    const relay = await createRawFirstResponse(
      `HTTP/1.1 ${status} Failure\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n`
    );
    const result = await connect(relay.port);
    expect(result).toMatchObject({ reason, status });
    expect(relay.requests).toHaveLength(1);
  });

  it.each([
    ['redirect', 'HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9/\r\nContent-Length: 0\r\n\r\n'],
    ['duplicate header', 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}'],
    ['chunked', 'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n'],
    ['folded header', 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n X-Fold: bad\r\n\r\n{}'],
    ['smuggled response', 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}HTTP/1.1 200 OK\r\n'],
    ['oversized header', `HTTP/1.1 200 OK\r\nX-Fill: ${'x'.repeat(17 * 1024)}\r\nContent-Length: 2\r\n\r\n{}`],
    ['oversized body', `HTTP/1.1 200 OK\r\nContent-Length: ${65 * 1024}\r\n\r\n`],
    ['malformed status', 'HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\n{}'],
  ])('fails closed on %s responses', async (_label, response) => {
    const relay = await createRawFirstResponse(response);
    expect((await connect(relay.port)).reason).toBe('protocol');
    expect(relay.requests).toHaveLength(1);
  });

  it('rejects duplicate security fields in JSON', async () => {
    const relay = await createValidRelay({ duplicateServerProof: true });
    expect((await connect(relay.port)).reason).toBe('protocol');
    expect(relay.requests).toHaveLength(1);
  });

  it('rejects non-loopback resolution before opening a socket', async () => {
    const result = await connectChromeDevtoolsRelayV2({
      baseUrl: new URL('http://relay.invalid:18799'),
      credential: CREDENTIAL,
      timeoutMs: 500,
      resolve: async () => [{ address: '203.0.113.9', family: 4 }] as never,
    });
    expect(result.reason).toBe('protocol');
  });

  it('tries every validated localhost address until one connects', async () => {
    const relay = await createValidRelay();
    const result = await connectChromeDevtoolsRelayV2({
      baseUrl: new URL(`http://localhost:${relay.port}`),
      credential: CREDENTIAL,
      timeoutMs: 2_000,
      resolve: async () =>
        [
          { address: '::1', family: 6 },
          { address: '127.0.0.1', family: 4 },
        ] as never,
    });
    expect(result).toMatchObject({ reason: 'success', status: 200, upstream: { head: expect.any(Buffer) } });
    expect(relay.connectionCount).toBe(1);
    result.upstream?.socket.destroy();
  });

  it('bounds loopback resolution by the configured timeout', async () => {
    const result = await connectChromeDevtoolsRelayV2({
      baseUrl: new URL('http://localhost:18799'),
      credential: CREDENTIAL,
      timeoutMs: 20,
      resolve: (() => new Promise<never>(() => {})) as never,
    });
    expect(result.reason).toBe('timeout');
    expect(result.durationMs).toBeGreaterThanOrEqual(10);
    expect(result.durationMs).toBeLessThan(500);
  });

  it('uses fresh nonces and closes each failed replay attempt instead of reconnecting', async () => {
    const nonces: string[] = [];
    const relay = await createRawServer((request, socket) => {
      nonces.push(String(request.body.clientNonce));
      writeJson(socket, 401, { error: 'Relay auth challenge rejected' }, { connection: 'close' });
    });
    expect((await connect(relay.port)).reason).toBe('replay');
    expect((await connect(relay.port)).reason).toBe('replay');
    expect(relay.connectionCount).toBe(2);
    expect(new Set(nonces).size).toBe(2);
  });

  it('retains the authenticated socket across a listener rebinding attempt', async () => {
    let relayServer: net.Server;
    let maliciousConnections = 0;
    let rebound: net.Server | undefined;
    const relay = await createValidRelay({
      beforeVersionResponse: async (server, port) => {
        relayServer = server;
        relayServer.close();
        await new Promise<void>((resolve) => setImmediate(resolve));
        rebound = net.createServer((socket) => {
          maliciousConnections += 1;
          socket.destroy();
        });
        servers.add(rebound);
        await new Promise<void>((resolve, reject) => {
          rebound?.once('error', reject);
          rebound?.listen(port, '127.0.0.1', resolve);
        });
      },
    });
    const result = await connect(relay.port);
    expect(result.reason).toBe('success');
    expect(relay.connectionCount).toBe(1);
    expect(maliciousConnections).toBe(0);
    result.upstream?.socket.destroy();
  });
});

interface CapturedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: ReadonlyMap<string, string>;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

interface RelayHarness {
  readonly server: net.Server;
  readonly port: number;
  readonly requests: CapturedRequest[];
  readonly connectionCount: number;
}

interface ValidRelayOptions {
  readonly now?: number;
  readonly mutateChallenge?: (challenge: Record<string, unknown>) => Record<string, unknown>;
  readonly mutateAccept?: (accepted: Record<string, unknown>) => Record<string, unknown>;
  readonly badAcceptProof?: boolean;
  readonly duplicateServerProof?: boolean;
  readonly versionStatus?: number;
  readonly beforeVersionResponse?: (server: net.Server, port: number) => Promise<void>;
  readonly flow?: 'cdp' | 'json-list';
}

async function createValidRelay(options: ValidRelayOptions = {}): Promise<RelayHarness> {
  let fields: ReturnType<typeof challengeFields>;
  return await createRawServer(async (request, socket, index, server, port) => {
    if (index === 0) {
      const now = options.now ?? Date.now();
      fields = {
        keyId: String(request.body.keyId),
        instanceId: INSTANCE_ID,
        sessionId: SESSION_ID,
        clientNonce: String(request.body.clientNonce),
        serverNonce: SERVER_NONCE,
        issuedAtMs: now,
        expiresAtMs: now + 10_000,
        role: 'cdp',
        transport: 'connection',
        method: String(request.body.method),
        resource: String(request.body.resource),
        flow: String(request.body.flow),
      };
      const challenge: Record<string, unknown> = {
        type: 'auth.challenge',
        v: 2,
        ...fields,
        serverProof: createBrowserRelayProof(KEY, 'server', fields),
      };
      const output = options.mutateChallenge?.(challenge) ?? challenge;
      if (options.duplicateServerProof) {
        const json = JSON.stringify(output).replace(/}$/, `,"serverProof":"${'A'.repeat(43)}"}`);
        writeRawJson(socket, 200, json);
      } else {
        writeJson(socket, 200, output);
      }
      return;
    }
    if (index === 1) {
      const clientProof = String(request.body.clientProof);
      const accepted: Record<string, unknown> = {
        type: 'auth.ok',
        v: 2,
        sessionId: fields.sessionId,
        acceptProof: options.badAcceptProof
          ? 'A'.repeat(43)
          : createBrowserRelayProof(KEY, 'accept', fields, clientProof),
      };
      writeJson(socket, 200, options.mutateAccept?.(accepted) ?? accepted);
      return;
    }
    if (index === 2) {
      if (options.flow === 'json-list') {
        writeRawJson(socket, 200, JSON.stringify([{ id: 'target-1' }]), { connection: 'close' });
        return;
      }
      await options.beforeVersionResponse?.(server, port);
      writeJson(socket, options.versionStatus ?? 200, options.versionStatus === 503 ? {} : { Browser: 'OpenClaw' });
      return;
    }
    if (index === 3) {
      const key = request.headers.get('sec-websocket-key') ?? '';
      const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
      );
    }
  });
}

async function createRawFirstResponse(response: string): Promise<RelayHarness> {
  return await createRawServer((_request, socket) => {
    socket.write(response);
  });
}

async function createRawServer(
  onRequest: (
    request: CapturedRequest,
    socket: net.Socket,
    index: number,
    server: net.Server,
    port: number
  ) => void | Promise<void>
): Promise<RelayHarness> {
  const requests: CapturedRequest[] = [];
  let connectionCount = 0;
  let port = 0;
  const server = net.createServer((socket) => {
    connectionCount += 1;
    sockets.add(socket);
    let buffered = Buffer.alloc(0);
    let processing = false;
    socket.on('data', (chunk) => {
      buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
      if (processing) return;
      processing = true;
      void (async () => {
        try {
          while (true) {
            const parsed = parseRequest(buffered);
            if (!parsed) break;
            buffered = buffered.subarray(parsed.bytes);
            const index = requests.length;
            requests.push(parsed.request);
            await onRequest(parsed.request, socket, index, server, port);
          }
        } finally {
          processing = false;
        }
      })();
    });
  });
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    requests,
    get connectionCount() {
      return connectionCount;
    },
  };
}

function parseRequest(buffer: Buffer): { request: CapturedRequest; bytes: number } | undefined {
  const boundary = buffer.indexOf('\r\n\r\n');
  if (boundary < 0) return undefined;
  const head = buffer.subarray(0, boundary).toString('latin1');
  const lines = head.split('\r\n');
  const [method = '', path = ''] = (lines.shift() ?? '').split(' ');
  const headers = new Map<string, string>();
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator > 0) headers.set(line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim());
  }
  const bodyLength = Number(headers.get('content-length') ?? 0);
  const bytes = boundary + 4 + bodyLength;
  if (buffer.length < bytes) return undefined;
  const bodySource = buffer.subarray(boundary + 4, bytes).toString('utf8');
  const body = bodySource ? (JSON.parse(bodySource) as Record<string, unknown>) : {};
  return { request: { method, path, headers, body, raw: buffer.subarray(0, bytes).toString('latin1') }, bytes };
}

function writeJson(
  socket: net.Socket,
  status: number,
  body: Record<string, unknown>,
  options: { connection?: 'keep-alive' | 'close' } = {}
): void {
  writeRawJson(socket, status, JSON.stringify(body), options);
}

function writeRawJson(
  socket: net.Socket,
  status: number,
  body: string,
  options: { connection?: 'keep-alive' | 'close' } = {}
): void {
  const encoded = Buffer.from(body, 'utf8');
  socket.write(
    Buffer.concat([
      Buffer.from(
        `HTTP/1.1 ${status} ${status === 200 ? 'OK' : 'Failure'}\r\nContent-Type: application/json\r\nContent-Length: ${encoded.byteLength}\r\nConnection: ${options.connection ?? 'keep-alive'}\r\n\r\n`,
        'ascii'
      ),
      encoded,
    ])
  );
}

function challengeFields(value: Record<string, unknown>) {
  return {
    keyId: String(value.keyId),
    instanceId: String(value.instanceId),
    sessionId: String(value.sessionId),
    clientNonce: String(value.clientNonce),
    serverNonce: String(value.serverNonce),
    issuedAtMs: Number(value.issuedAtMs),
    expiresAtMs: Number(value.expiresAtMs),
    role: String(value.role),
    transport: String(value.transport),
    method: String(value.method),
    resource: String(value.resource),
    flow: String(value.flow),
  };
}

function omitField(value: Record<string, unknown>, field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
}

async function connect(port: number, now?: number, flow?: 'cdp' | 'json-list') {
  return await connectChromeDevtoolsRelayV2({
    baseUrl: new URL(`http://127.0.0.1:${port}`),
    credential: CREDENTIAL,
    timeoutMs: 2_000,
    now: now === undefined ? undefined : () => now,
    flow,
  });
}
