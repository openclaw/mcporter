import { createHash } from 'node:crypto';
import net, { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startChromeDevtoolsRelayProxy } from '../src/chrome-devtools-relay-proxy.js';

const WEBSOCKET_KEY = Buffer.from('0123456789abcdef').toString('base64');
const WEBSOCKET_ACCEPT = createHash('sha1')
  .update(`${WEBSOCKET_KEY}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
  .digest('base64');
const servers = new Set<net.Server>();
const sockets = new Set<net.Socket>();

afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    )
  );
  servers.clear();
});

describe('chrome-devtools authenticated relay proxy', () => {
  it('keeps the handoff authorization and bridges one child to the retained upstream socket', async () => {
    const upstream = await createSocketPair();
    const proxy = await startChromeDevtoolsRelayProxy({
      upstream: { socket: upstream.client, head: Buffer.from('early-upstream-frame') },
    });
    try {
      const authorization = proxy.consumeClientAuthorization();
      expectEphemeralAuthorization(authorization);
      const endpoint = new URL(proxy.endpoint);

      await expect(rawClosedUpgrade(Number(endpoint.port), [])).resolves.toContain('404 Not Found');
      await expect(
        rawClosedUpgrade(Number(endpoint.port), [`Authorization: Bearer ${'x'.repeat(43)}`])
      ).resolves.toContain('404 Not Found');
      await expect(
        rawClosedUpgrade(Number(endpoint.port), [`Authorization: ${authorization}`, `Authorization: ${authorization}`])
      ).resolves.toContain('404 Not Found');

      const downstream = await openUpgrade(Number(endpoint.port), [`Authorization: ${authorization}`]);
      expect(downstream.response).toContain('101 Switching Protocols');
      expect(downstream.response).toContain(`Sec-WebSocket-Accept: ${WEBSOCKET_ACCEPT}`);
      expect(downstream.response).not.toContain(authorization);
      expect(downstream.trailing).toBe('early-upstream-frame');

      const upstreamData = onceData(upstream.peer);
      downstream.socket.write('child-frame');
      await expect(upstreamData).resolves.toBe('child-frame');

      const downstreamData = onceData(downstream.socket);
      upstream.peer.write('relay-frame');
      await expect(downstreamData).resolves.toBe('relay-frame');
      downstream.socket.destroy();
    } finally {
      await proxy.close();
    }
  });

  it('atomically accepts one downstream and rejects a concurrent replay', async () => {
    const upstream = await createSocketPair();
    const proxy = await startChromeDevtoolsRelayProxy({ upstream: { socket: upstream.client, head: Buffer.alloc(0) } });
    try {
      const endpoint = new URL(proxy.endpoint);
      const authorization = proxy.consumeClientAuthorization();
      const first = await connectSocket(Number(endpoint.port));
      const second = await connectSocket(Number(endpoint.port));
      const firstResponse = collectUntilHeaders(first);
      const secondOutcome = collectUntilClose(second).then(
        (response) => ({ response }),
        (error: unknown) => ({ error })
      );
      const request = upgradeRequest([`Authorization: ${authorization}`]);
      first.write(request);
      second.write(request);
      await expect(firstResponse).resolves.toContain('101 Switching Protocols');
      const outcome = await secondOutcome;
      if ('response' in outcome) {
        expect(outcome.response).toContain('404 Not Found');
      } else {
        // Node may reset an already-accepted idle socket when the one-use server closes.
        expect(outcome.error).toMatchObject({ code: 'ECONNRESET' });
      }
    } finally {
      await proxy.close();
    }
  });

  it('closes the proxy and child when the retained upstream is lost', async () => {
    const upstream = await createSocketPair();
    const proxy = await startChromeDevtoolsRelayProxy({ upstream: { socket: upstream.client, head: Buffer.alloc(0) } });
    const endpoint = new URL(proxy.endpoint);
    const downstream = await openUpgrade(Number(endpoint.port), [
      `Authorization: ${proxy.consumeClientAuthorization()}`,
    ]);
    const closed = onceClose(downstream.socket);
    upstream.peer.destroy();
    await closed;
    await expect(connectSocket(Number(endpoint.port))).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    await proxy.close();
  });

  it('generates distinct one-time high-entropy handoff authorization', async () => {
    const firstPair = await createSocketPair();
    const secondPair = await createSocketPair();
    const first = await startChromeDevtoolsRelayProxy({
      upstream: { socket: firstPair.client, head: Buffer.alloc(0) },
    });
    const second = await startChromeDevtoolsRelayProxy({
      upstream: { socket: secondPair.client, head: Buffer.alloc(0) },
    });
    try {
      const firstAuthorization = first.consumeClientAuthorization();
      const secondAuthorization = second.consumeClientAuthorization();
      expectEphemeralAuthorization(firstAuthorization);
      expectEphemeralAuthorization(secondAuthorization);
      expect(firstAuthorization).not.toBe(secondAuthorization);
      expect(() => first.consumeClientAuthorization()).toThrow('already consumed');
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('closes an unattached authenticated upstream when the proxy is retired', async () => {
    const upstream = await createSocketPair();
    const proxy = await startChromeDevtoolsRelayProxy({ upstream: { socket: upstream.client, head: Buffer.alloc(0) } });
    const peerClosed = onceClose(upstream.peer);
    await proxy.close();
    await peerClosed;
    expect(upstream.client.destroyed).toBe(true);
  });
});

async function createSocketPair(): Promise<{ client: net.Socket; peer: net.Socket }> {
  let accept!: (socket: net.Socket) => void;
  const accepted = new Promise<net.Socket>((resolve) => {
    accept = resolve;
  });
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    accept(socket);
  });
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const client = await connectSocket(port);
  const peer = await accepted;
  return { client, peer };
}

async function connectSocket(port: number): Promise<net.Socket> {
  return await new Promise<net.Socket>((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    sockets.add(socket);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function rawClosedUpgrade(port: number, headers: readonly string[]): Promise<string> {
  const socket = await connectSocket(port);
  const response = collectUntilClose(socket);
  socket.write(upgradeRequest(headers));
  return await response;
}

async function openUpgrade(
  port: number,
  headers: readonly string[]
): Promise<{ socket: net.Socket; response: string; trailing: string }> {
  const socket = await connectSocket(port);
  const raw = collectUntilHeaders(socket);
  socket.write(upgradeRequest(headers));
  const response = await raw;
  const boundary = response.indexOf('\r\n\r\n');
  return { socket, response: response.slice(0, boundary + 4), trailing: response.slice(boundary + 4) };
}

function upgradeRequest(headers: readonly string[]): string {
  return [
    'GET /cdp HTTP/1.1',
    'Host: 127.0.0.1',
    'Connection: Upgrade',
    'Upgrade: websocket',
    `Sec-WebSocket-Key: ${WEBSOCKET_KEY}`,
    'Sec-WebSocket-Version: 13',
    ...headers,
    '',
    '',
  ].join('\r\n');
}

async function collectUntilHeaders(socket: net.Socket): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let response = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      response += chunk;
      if (response.includes('\r\n\r\n')) resolve(response);
    });
    socket.once('error', reject);
    socket.once('close', () => {
      if (!response.includes('\r\n\r\n')) reject(new Error('Socket closed before response headers.'));
    });
  });
}

async function collectUntilClose(socket: net.Socket): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let response = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.once('error', reject);
    socket.once('close', () => resolve(response));
  });
}

async function onceData(socket: net.Socket): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    socket.once('data', (chunk) => resolve(chunk.toString()));
    socket.once('error', reject);
  });
}

async function onceClose(socket: net.Socket): Promise<void> {
  await new Promise<void>((resolve) => socket.once('close', () => resolve()));
}

function expectEphemeralAuthorization(authorization: string): void {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/u.exec(authorization);
  expect(match).not.toBeNull();
  expect(Buffer.from(match?.[1] ?? '', 'base64url').byteLength).toBeGreaterThanOrEqual(32);
}
