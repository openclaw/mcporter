import http, { type IncomingHttpHeaders } from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { startChromeDevtoolsRelayProxy, type ChromeDevtoolsRelayProxy } from '../src/chrome-devtools-relay-proxy.js';

const TOKEN = 'b'.repeat(64);
const servers = new Set<http.Server>();

afterEach(async () => {
  await Promise.all(
    [...servers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        })
    )
  );
  servers.clear();
});

describe('chrome-devtools relay credential proxy', () => {
  it('requires the ephemeral authorization and forwards only a minimal authenticated WebSocket handshake', async () => {
    let upstreamHeaders: IncomingHttpHeaders | undefined;
    let upstreamPath: string | undefined;
    let upstreamUpgrades = 0;
    const upstream = await createUpstream((request, socket) => {
      upstreamUpgrades += 1;
      upstreamHeaders = request.headers;
      upstreamPath = request.url;
      socket.end(
        `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: test\r\nSec-WebSocket-Protocol: cdp.v1\r\nSet-Cookie: relay=${TOKEN}\r\nX-Relay-Secret: ${TOKEN}\r\n\r\n`
      );
    });
    const proxy = await startProxyFor(upstream);

    try {
      const clientAuthorization = proxy.consumeClientAuthorization();
      const endpoint = new URL(proxy.endpoint);
      expect(endpoint.hostname).toBe('127.0.0.1');
      expect(endpoint.pathname).toBe('/cdp');
      expectEphemeralAuthorization(clientAuthorization);

      await expect(rawUpgrade(Number(endpoint.port), '/cdp')).resolves.toContain('404 Not Found');
      await expect(
        rawUpgrade(Number(endpoint.port), '/cdp', [`Authorization: Bearer ${'x'.repeat(43)}`])
      ).resolves.toContain('404 Not Found');
      await expect(
        rawUpgrade(Number(endpoint.port), '/cdp/guessed', [`Authorization: ${clientAuthorization}`])
      ).resolves.toContain('404 Not Found');
      expect(upstreamUpgrades).toBe(0);

      const response = await rawUpgrade(Number(endpoint.port), endpoint.pathname, [
        `Authorization: ${clientAuthorization}`,
        'Cookie: local-session=attacker',
        'Proxy-Authorization: Basic attacker',
        'Origin: https://attacker.example',
        'Sec-WebSocket-Extensions: permessage-deflate',
        'Sec-WebSocket-Protocol: cdp.v1',
        'X-Local-Secret: do-not-forward',
      ]);
      expect(response).toContain('101 Switching Protocols');
      expect(response).not.toContain(TOKEN);
      expect(response).not.toContain('Set-Cookie');
      expect(response).not.toContain('X-Relay-Secret');
      expect(upstreamUpgrades).toBe(1);
      expect(upstreamPath).toBe('/cdp');
      expect(upstreamHeaders).toMatchObject({
        authorization: `Bearer ${TOKEN}`,
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'abc',
        'sec-websocket-version': '13',
        'sec-websocket-protocol': 'cdp.v1',
      });
      expect(upstreamHeaders?.host).toMatch(/^127\.0\.0\.1:\d+$/u);
      expect(upstreamHeaders?.cookie).toBeUndefined();
      expect(upstreamHeaders?.['proxy-authorization']).toBeUndefined();
      expect(upstreamHeaders?.origin).toBeUndefined();
      expect(upstreamHeaders?.['sec-websocket-extensions']).toBeUndefined();
      expect(upstreamHeaders?.['x-local-secret']).toBeUndefined();
    } finally {
      await proxy.close();
    }

    const endpoint = new URL(proxy.endpoint);
    await expect(connect(Number(endpoint.port))).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('generates distinct high-entropy authorization for each proxy instance', async () => {
    const upstream = await createUpstream((_request, socket) => socket.destroy());
    const first = await startProxyFor(upstream);
    const second = await startProxyFor(upstream);
    try {
      const firstAuthorization = first.consumeClientAuthorization();
      const secondAuthorization = second.consumeClientAuthorization();
      expectEphemeralAuthorization(firstAuthorization);
      expectEphemeralAuthorization(secondAuthorization);
      expect(firstAuthorization === secondAuthorization).toBe(false);
      expect(() => first.consumeClientAuthorization()).toThrow('already consumed');
    } finally {
      await Promise.all([first.close(), second.close()]);
    }
  });

  it('closes downstream safely when a non-upgrade upstream response is truncated', async () => {
    const upstream = await createUpstream((_request, socket) => {
      socket.write(
        `HTTP/1.1 503 Service Unavailable\r\nContent-Length: 100\r\nX-Relay-Secret: ${TOKEN}\r\nConnection: close\r\n\r\n${TOKEN}`
      );
      socket.destroy();
    });
    const proxy = await startProxyFor(upstream);
    try {
      const endpoint = new URL(proxy.endpoint);
      const authorization = proxy.consumeClientAuthorization();
      const response = await rawUpgrade(Number(endpoint.port), endpoint.pathname, [`Authorization: ${authorization}`]);
      expect(response).toContain('502 Bad Gateway');
      expect(response).not.toContain(TOKEN);
    } finally {
      await proxy.close();
    }
  });
});

async function createUpstream(
  onUpgrade: (request: http.IncomingMessage, socket: net.Socket) => void
): Promise<http.Server> {
  const server = http.createServer();
  servers.add(server);
  server.on('upgrade', onUpgrade);
  await listen(server);
  return server;
}

async function startProxyFor(upstream: http.Server): Promise<ChromeDevtoolsRelayProxy> {
  const upstreamAddress = upstream.address() as AddressInfo;
  return await startChromeDevtoolsRelayProxy({
    upstreamEndpoint: new URL(`ws://127.0.0.1:${upstreamAddress.port}/cdp`),
    token: TOKEN,
  });
}

function expectEphemeralAuthorization(authorization: string): void {
  const match = /^Bearer ([A-Za-z0-9_-]+)$/u.exec(authorization);
  expect(match).not.toBeNull();
  expect(Buffer.from(match?.[1] ?? '', 'base64url').byteLength).toBeGreaterThanOrEqual(32);
}

async function listen(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
}

async function rawUpgrade(port: number, pathname: string, extraHeaders: readonly string[] = []): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    let response = '';
    socket.setEncoding('utf8');
    socket.once('error', reject);
    socket.on('data', (chunk) => {
      response += chunk;
    });
    socket.once('close', () => resolve(response));
    socket.once('connect', () => {
      socket.write(
        [
          `GET ${pathname} HTTP/1.1`,
          'Host: 127.0.0.1',
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Key: abc',
          'Sec-WebSocket-Version: 13',
          ...extraHeaders,
          '',
          '',
        ].join('\r\n')
      );
    });
  });
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
