import { randomBytes, timingSafeEqual } from 'node:crypto';
import http, { type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

export interface ChromeDevtoolsRelayProxy {
  readonly endpoint: string;
  consumeClientAuthorization(): string;
  close(): Promise<void>;
}

/**
 * Keeps the OpenClaw relay credential inside mcporter while presenting a
 * short-lived loopback WebSocket endpoint protected by ephemeral authorization.
 */
export async function startChromeDevtoolsRelayProxy(options: {
  readonly upstreamEndpoint: URL;
  readonly token: string;
}): Promise<ChromeDevtoolsRelayProxy> {
  const sockets = new Set<Duplex>();
  const clientAuthorization = `Bearer ${randomBytes(32).toString('base64url')}`;
  const server = http.createServer((_request, response) => {
    response.writeHead(404).end();
  });
  server.on('connection', (socket) => trackSocket(sockets, socket));

  server.on('upgrade', (request, downstream, head) => {
    if (request.url !== '/cdp' || !safeHeaderEqual(request.headers.authorization, clientAuthorization)) {
      downstream.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }

    const headers = buildUpstreamHeaders(request, options.upstreamEndpoint, options.token);
    const upstreamRequest = http.request({
      protocol: 'http:',
      hostname: options.upstreamEndpoint.hostname.replace(/^\[(.*)\]$/u, '$1'),
      port: options.upstreamEndpoint.port,
      path: `${options.upstreamEndpoint.pathname}${options.upstreamEndpoint.search}`,
      method: 'GET',
      headers,
    });

    upstreamRequest.once('upgrade', (response, upstream, upstreamHead) => {
      trackSocket(sockets, upstream);
      upstream.once('error', () => downstream.destroy());
      downstream.write(serializeUpgradeResponse(response));
      if (upstreamHead.length > 0) downstream.write(upstreamHead);
      if (head.length > 0) upstream.write(head);
      downstream.pipe(upstream).pipe(downstream);
    });
    upstreamRequest.once('response', (response) => {
      response.once('error', () => {});
      response.once('aborted', () => {});
      downstream.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      response.destroy();
    });
    upstreamRequest.once('error', () => {
      downstream.destroy();
    });
    downstream.once('error', () => upstreamRequest.destroy());
    downstream.once('close', () => upstreamRequest.destroy());
    upstreamRequest.end();
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  if (!address || address.address !== '127.0.0.1') {
    server.close();
    throw new Error('Chrome relay proxy failed to bind to IPv4 loopback.');
  }

  let closed = false;
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
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function safeHeaderEqual(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function buildUpstreamHeaders(request: IncomingMessage, upstream: URL, token: string): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {
    host: upstream.host,
    authorization: `Bearer ${token}`,
    connection: 'Upgrade',
    upgrade: 'websocket',
  };
  copyHeader(request, headers, 'sec-websocket-key');
  copyHeader(request, headers, 'sec-websocket-version');
  copyHeader(request, headers, 'sec-websocket-protocol');
  return headers;
}

function copyHeader(request: IncomingMessage, target: http.OutgoingHttpHeaders, name: string): void {
  const value = request.headers[name];
  if (typeof value === 'string' || Array.isArray(value)) target[name] = value;
}

function serializeUpgradeResponse(response: IncomingMessage): string {
  const lines = ['HTTP/1.1 101 Switching Protocols', 'Connection: Upgrade', 'Upgrade: websocket'];
  appendResponseHeader(response, lines, 'sec-websocket-accept');
  appendResponseHeader(response, lines, 'sec-websocket-protocol');
  return `${lines.join('\r\n')}\r\n\r\n`;
}

function appendResponseHeader(response: IncomingMessage, lines: string[], name: string): void {
  const value = response.headers[name];
  if (typeof value === 'string') lines.push(`${name}: ${value}`);
}

function trackSocket(sockets: Set<Duplex>, socket: Duplex): void {
  if (sockets.has(socket)) return;
  sockets.add(socket);
  socket.once('close', () => sockets.delete(socket));
}
