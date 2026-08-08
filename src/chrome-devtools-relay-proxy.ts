import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import type { AuthenticatedChromeDevtoolsRelay } from './chrome-devtools-relay-client.js';

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export interface ChromeDevtoolsRelayProxy {
  readonly endpoint: string;
  consumeClientAuthorization(): string;
  close(): Promise<void>;
}

/**
 * Presents the already-authenticated and already-upgraded OpenClaw socket as a
 * one-use loopback WebSocket protected by the existing ephemeral handoff.
 */
export async function startChromeDevtoolsRelayProxy(options: {
  readonly upstream: AuthenticatedChromeDevtoolsRelay;
}): Promise<ChromeDevtoolsRelayProxy> {
  const sockets = new Set<Duplex>();
  const clientAuthorization = `Bearer ${randomBytes(32).toString('base64url')}`;
  let downstreamAccepted = false;
  let closed = false;
  const server = http.createServer((_request, response) => {
    response.writeHead(404, { Connection: 'close', 'Content-Length': '0' }).end();
  });
  server.on('connection', (socket) => trackSocket(sockets, socket));

  server.on('upgrade', (request, downstream, head) => {
    if (
      closed ||
      downstreamAccepted ||
      !isValidDownstreamUpgrade(request, clientAuthorization) ||
      options.upstream.socket.destroyed
    ) {
      downstream.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    downstreamAccepted = true;
    const key = request.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      downstream.destroy();
      return;
    }
    const accept = createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
    downstream.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Connection: Upgrade',
        'Upgrade: websocket',
        `Sec-WebSocket-Accept: ${accept}`,
        '',
        '',
      ].join('\r\n')
    );
    if (options.upstream.head.length > 0) downstream.write(options.upstream.head);
    if (head.length > 0) options.upstream.socket.write(head);
    options.upstream.socket.once('error', () => downstream.destroy());
    options.upstream.socket.once('close', () => downstream.destroy());
    downstream.once('error', () => options.upstream.socket.destroy());
    downstream.once('close', () => options.upstream.socket.destroy());
    downstream.pipe(options.upstream.socket).pipe(downstream);
    server.close();
  });

  const onUpstreamClose = (): void => {
    void closeServer(server, sockets);
  };
  options.upstream.socket.once('close', onUpstreamClose);

  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      server.once('error', onError);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onError);
        resolve();
      });
    });
  } catch (error) {
    closeUpstream(options.upstream.socket);
    throw error;
  }

  const address = server.address() as AddressInfo | null;
  if (!address || address.address !== '127.0.0.1') {
    closeUpstream(options.upstream.socket);
    server.close();
    throw new Error('Chrome relay proxy failed to bind to IPv4 loopback.');
  }

  let authorizationAvailable = true;
  return {
    endpoint: `ws://127.0.0.1:${address.port}/cdp`,
    consumeClientAuthorization() {
      if (!authorizationAvailable) throw new Error('Chrome relay authorization handoff already consumed.');
      authorizationAvailable = false;
      return clientAuthorization;
    },
    async close() {
      if (closed) return;
      closed = true;
      options.upstream.socket.off('close', onUpstreamClose);
      closeUpstream(options.upstream.socket);
      await closeServer(server, sockets);
    },
  };
}

function isValidDownstreamUpgrade(request: IncomingMessage, expectedAuthorization: string): boolean {
  if (
    request.url !== '/cdp' ||
    request.method !== 'GET' ||
    request.headers.upgrade?.toLowerCase() !== 'websocket' ||
    !hasToken(request.headers.connection, 'upgrade') ||
    request.headers['sec-websocket-version'] !== '13' ||
    countRawHeader(request, 'authorization') !== 1 ||
    countRawHeader(request, 'sec-websocket-key') !== 1 ||
    !safeHeaderEqual(request.headers.authorization, expectedAuthorization)
  ) {
    return false;
  }
  const key = request.headers['sec-websocket-key'];
  if (typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/u.test(key)) return false;
  const decoded = Buffer.from(key, 'base64');
  return decoded.byteLength === 16 && decoded.toString('base64') === key;
}

function countRawHeader(request: IncomingMessage, expectedName: string): number {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === expectedName) count += 1;
  }
  return count;
}

function safeHeaderEqual(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function hasToken(value: string | undefined, expected: string): boolean {
  return Boolean(value?.split(',').some((token) => token.trim().toLowerCase() === expected));
}

function trackSocket(sockets: Set<Duplex>, socket: Duplex): void {
  if (sockets.has(socket)) return;
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
}

function closeUpstream(socket: AuthenticatedChromeDevtoolsRelay['socket']): void {
  if (socket.destroyed) return;
  if (!socket.remoteAddress) {
    socket.destroy();
    return;
  }
  try {
    socket.resetAndDestroy();
  } catch {
    socket.destroy();
  }
}

async function closeServer(server: http.Server, sockets: Set<Duplex>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
