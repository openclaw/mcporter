import { createHash, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import net from 'node:net';
import { TextDecoder } from 'node:util';
import { parseTree, type Node as JsonNode, type ParseError } from 'jsonc-parser';
import {
  BROWSER_RELAY_AUTH_CHALLENGE_PATH,
  BROWSER_RELAY_AUTH_COMPLETE_PATH,
  BROWSER_RELAY_AUTH_VERSION,
  BROWSER_RELAY_CHALLENGE_MAX_LIFETIME_MS,
  BROWSER_RELAY_CLOCK_SKEW_MS,
  BROWSER_RELAY_CDP_FLOW,
  BROWSER_RELAY_CDP_METHOD,
  BROWSER_RELAY_CDP_PATH,
  BROWSER_RELAY_CDP_RESOURCE,
  BROWSER_RELAY_CDP_ROLE,
  BROWSER_RELAY_CDP_TRANSPORT,
  BROWSER_RELAY_VERSION_PATH,
  createBrowserRelayProof,
  type BrowserRelayProofFields,
  verifyBrowserRelayProof,
} from './browser-relay-auth-v2.js';

const MAX_HEADER_BYTES = 16 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export type ChromeDevtoolsRelayV2Reason =
  | 'unsupported-auth'
  | 'bad-server-proof'
  | 'server-auth-failed'
  | 'replay'
  | 'protocol'
  | 'freshness'
  | 'sequence'
  | 'extension-disconnected'
  | 'timeout'
  | 'network-error'
  | 'success';

export interface AuthenticatedChromeDevtoolsRelay {
  readonly socket: net.Socket;
  readonly head: Buffer;
}

export interface ChromeDevtoolsRelayV2Result {
  readonly reason: ChromeDevtoolsRelayV2Reason;
  readonly durationMs: number;
  readonly status?: number;
  readonly upstream?: AuthenticatedChromeDevtoolsRelay;
  readonly json?: unknown;
}

export interface ChromeDevtoolsRelayCredential {
  readonly key: Buffer;
  readonly keyId: string;
}

class RelayV2Error extends Error {
  constructor(
    readonly reason: Exclude<ChromeDevtoolsRelayV2Reason, 'success' | 'extension-disconnected'>,
    readonly status?: number
  ) {
    super(`Chrome relay authentication failed (${reason}).`);
    this.name = 'RelayV2Error';
  }
}

interface HttpResponse {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly body: Buffer;
}

export async function connectChromeDevtoolsRelayV2(options: {
  readonly baseUrl: URL;
  readonly credential: ChromeDevtoolsRelayCredential;
  readonly timeoutMs: number;
  readonly now?: () => number;
  readonly resolve?: typeof lookup;
  readonly flow?: 'cdp' | 'json-list';
}): Promise<ChromeDevtoolsRelayV2Result> {
  const startedAt = performance.now();
  const durationMs = (): number => Math.max(0, Math.round(performance.now() - startedAt));
  let socket: net.Socket | undefined;
  let timer: NodeJS.Timeout | undefined;
  try {
    let timedOut = false;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        const error = new RelayV2Error('timeout');
        socket?.destroy(error);
        reject(error);
      }, options.timeoutMs);
    });
    timer?.unref();
    const addresses = await Promise.race([
      resolveLoopbackAddresses(options.baseUrl.hostname, options.resolve ?? lookup),
      timeout,
    ]);
    const port = resolvePort(options.baseUrl);
    let lastConnectionError: unknown;
    for (const address of addresses) {
      socket = net.createConnection({ host: address.address, family: address.family, port });
      try {
        await waitForConnect(socket);
        lastConnectionError = undefined;
        break;
      } catch (error) {
        socket.destroy();
        if (timedOut || isTimeoutError(error)) throw new RelayV2Error('timeout');
        lastConnectionError = error;
      }
    }
    if (lastConnectionError) throw lastConnectionError;
    if (!socket || socket.destroyed) throw new RelayV2Error(timedOut ? 'timeout' : 'network-error');
    if (!socket.remoteAddress || !isNumericLoopback(socket.remoteAddress)) throw new RelayV2Error('protocol');

    const reader = new SocketReader(socket);
    const flow = options.flow ?? 'cdp';
    const clientNonce = randomBytes(32).toString('base64url');
    const hello = {
      v: BROWSER_RELAY_AUTH_VERSION,
      keyId: options.credential.keyId,
      clientNonce,
      role: BROWSER_RELAY_CDP_ROLE,
      transport: BROWSER_RELAY_CDP_TRANSPORT,
      method: flow === BROWSER_RELAY_CDP_FLOW ? BROWSER_RELAY_CDP_METHOD : 'GET',
      resource: flow === BROWSER_RELAY_CDP_FLOW ? BROWSER_RELAY_CDP_RESOURCE : '/json/list',
      flow,
    } as const;
    await writeJsonRequest(socket, options.baseUrl.host, BROWSER_RELAY_AUTH_CHALLENGE_PATH, hello);
    const challengeResponse = await reader.readHttpResponse(MAX_JSON_BYTES);
    ensureAuthStatus(challengeResponse, 'challenge');
    const challenge = parseStrictJsonObject(challengeResponse.body);
    const fields = validateChallenge(challenge, hello, options.now?.() ?? Date.now());
    const serverProof = requireString(challenge, 'serverProof');
    if (!verifyBrowserRelayProof(options.credential.key, 'server', fields, serverProof)) {
      throw new RelayV2Error('bad-server-proof');
    }

    const clientProof = createBrowserRelayProof(options.credential.key, 'client', fields);
    await writeJsonRequest(socket, options.baseUrl.host, BROWSER_RELAY_AUTH_COMPLETE_PATH, {
      v: BROWSER_RELAY_AUTH_VERSION,
      sessionId: fields.sessionId,
      clientProof,
    });
    const completeResponse = await reader.readHttpResponse(MAX_JSON_BYTES);
    ensureAuthStatus(completeResponse, 'complete');
    const accepted = parseStrictJsonObject(completeResponse.body);
    validateAccept(accepted, fields.sessionId);
    if (
      !verifyBrowserRelayProof(
        options.credential.key,
        'accept',
        fields,
        requireString(accepted, 'acceptProof'),
        clientProof
      )
    ) {
      throw new RelayV2Error('bad-server-proof');
    }

    if (flow === 'json-list') {
      await writeRequest(socket, options.baseUrl.host, 'GET', '/json/list', []);
      const listResponse = await reader.readHttpResponse(MAX_JSON_BYTES, true);
      if (listResponse.status !== 200) throw classifyStatus(listResponse.status, true);
      const json = parseStrictJson(listResponse.body);
      if (!Array.isArray(json)) throw new RelayV2Error('protocol', 200);
      socket.destroy();
      return { reason: 'success', durationMs: durationMs(), status: 200, json };
    }

    await writeRequest(socket, options.baseUrl.host, 'GET', BROWSER_RELAY_VERSION_PATH, []);
    const versionResponse = await reader.readHttpResponse(MAX_JSON_BYTES);
    if (versionResponse.status === 503) {
      socket.destroy();
      return { reason: 'extension-disconnected', durationMs: durationMs(), status: 503 };
    }
    if (versionResponse.status !== 200) throw classifyStatus(versionResponse.status, true);
    parseStrictJsonObject(versionResponse.body);

    const websocketKey = randomBytes(16).toString('base64');
    await writeRequest(socket, options.baseUrl.host, 'GET', BROWSER_RELAY_CDP_PATH, [
      ['Connection', 'Upgrade'],
      ['Upgrade', 'websocket'],
      ['Sec-WebSocket-Key', websocketKey],
      ['Sec-WebSocket-Version', '13'],
    ]);
    const upgrade = await reader.readHttpUpgrade();
    if (upgrade.status !== 101) throw classifyStatus(upgrade.status, true);
    const expectedAccept = createHash('sha1').update(`${websocketKey}${WEBSOCKET_GUID}`).digest('base64');
    if (
      upgrade.headers.get('upgrade')?.toLowerCase() !== 'websocket' ||
      !hasToken(upgrade.headers.get('connection'), 'upgrade') ||
      upgrade.headers.get('sec-websocket-accept') !== expectedAccept
    ) {
      throw new RelayV2Error('sequence', 101);
    }
    const head = reader.release();
    if (timer) clearTimeout(timer);
    return { reason: 'success', durationMs: durationMs(), status: 200, upstream: { socket, head } };
  } catch (error) {
    socket?.destroy();
    if (error instanceof RelayV2Error) {
      return { reason: error.reason, durationMs: durationMs(), status: error.status };
    }
    return { reason: isTimeoutError(error) ? 'timeout' : 'network-error', durationMs: durationMs() };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function resolveLoopbackAddresses(hostname: string, resolver: typeof lookup) {
  const normalized = hostname.replace(/^\[(.*)\]$/u, '$1');
  const addresses = await resolver(normalized, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some((address) => !isNumericLoopback(address.address))) {
    throw new RelayV2Error('protocol');
  }
  return addresses;
}

function resolvePort(url: URL): number {
  const port = url.port === '' ? 80 : Number(url.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new RelayV2Error('protocol');
  return port;
}

function isNumericLoopback(address: string): boolean {
  if (net.isIPv4(address)) return address.startsWith('127.');
  if (!net.isIPv6(address)) return false;
  const normalized = address.toLowerCase();
  return normalized === '::1' || normalized.startsWith('::ffff:127.');
}

async function waitForConnect(socket: net.Socket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onConnect = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      socket.off('connect', onConnect);
      socket.off('error', onError);
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

class SocketReader {
  private buffered = Buffer.alloc(0);
  private failure: Error | undefined;
  private ended = false;
  private readonly onData = (chunk: Buffer): void => {
    this.buffered = Buffer.concat([this.buffered, chunk]);
  };
  private readonly onError = (error: Error): void => {
    this.failure = error;
  };
  private readonly onClose = (): void => {
    this.ended = true;
  };

  constructor(private readonly socket: net.Socket) {
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  async readHttpResponse(maxBodyBytes: number, allowConnectionClose = false): Promise<HttpResponse> {
    const parsed = await this.readHeaders();
    if (parsed.status === 101) throw new RelayV2Error('protocol', 101);
    if (parsed.headers.has('transfer-encoding')) throw new RelayV2Error('protocol', parsed.status);
    if (!allowConnectionClose && parsed.status === 200 && hasToken(parsed.headers.get('connection'), 'close')) {
      throw new RelayV2Error('protocol', parsed.status);
    }
    const rawLength = parsed.headers.get('content-length');
    if (!rawLength || !/^\d+$/u.test(rawLength)) throw new RelayV2Error('protocol', parsed.status);
    const length = Number(rawLength);
    if (!Number.isSafeInteger(length) || length > maxBodyBytes) throw new RelayV2Error('protocol', parsed.status);
    await this.waitForBytes(length);
    const body = this.buffered.subarray(0, length);
    this.buffered = this.buffered.subarray(length);
    if (this.buffered.length > 0) throw new RelayV2Error('protocol', parsed.status);
    return { ...parsed, body };
  }

  async readHttpUpgrade(): Promise<HttpResponse> {
    const parsed = await this.readHeaders();
    if (parsed.headers.has('transfer-encoding')) throw new RelayV2Error('protocol', parsed.status);
    if (parsed.status === 101) {
      if (parsed.headers.has('content-length')) throw new RelayV2Error('protocol', parsed.status);
      return { ...parsed, body: Buffer.alloc(0) };
    }
    const rawLength = parsed.headers.get('content-length');
    if (!rawLength || !/^\d+$/u.test(rawLength)) throw new RelayV2Error('protocol', parsed.status);
    const length = Number(rawLength);
    if (!Number.isSafeInteger(length) || length > MAX_JSON_BYTES) throw new RelayV2Error('protocol', parsed.status);
    await this.waitForBytes(length);
    const body = this.buffered.subarray(0, length);
    this.buffered = this.buffered.subarray(length);
    if (this.buffered.length > 0) throw new RelayV2Error('protocol', parsed.status);
    return { ...parsed, body };
  }

  release(): Buffer {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
    const head = this.buffered;
    this.buffered = Buffer.alloc(0);
    return head;
  }

  private async readHeaders(): Promise<Omit<HttpResponse, 'body'>> {
    let boundary = this.buffered.indexOf('\r\n\r\n');
    while (boundary < 0) {
      if (this.buffered.length > MAX_HEADER_BYTES) throw new RelayV2Error('protocol');
      await this.waitForData();
      boundary = this.buffered.indexOf('\r\n\r\n');
    }
    if (boundary > MAX_HEADER_BYTES) throw new RelayV2Error('protocol');
    const raw = this.buffered.subarray(0, boundary).toString('latin1');
    this.buffered = this.buffered.subarray(boundary + 4);
    const lines = raw.split('\r\n');
    const statusLine = lines.shift();
    const match = /^HTTP\/1\.1 ([1-5]\d\d)(?: [\x20-\x7e]*)?$/u.exec(statusLine ?? '');
    if (!match) throw new RelayV2Error('protocol');
    const status = Number(match[1]);
    const headers = new Map<string, string>();
    for (const line of lines) {
      if (/^[ \t]/u.test(line)) throw new RelayV2Error('protocol', status);
      const separator = line.indexOf(':');
      if (separator <= 0) throw new RelayV2Error('protocol', status);
      const name = line.slice(0, separator).toLowerCase();
      const value = line.slice(separator + 1).trim();
      if (
        !/^[!#$%&'*+.^_`|~0-9a-z-]+$/u.test(name) ||
        value.includes('\u0000') ||
        value.includes('\r') ||
        value.includes('\n') ||
        value.includes('\u007f')
      ) {
        throw new RelayV2Error('protocol', status);
      }
      if (headers.has(name)) throw new RelayV2Error('protocol', status);
      headers.set(name, value);
    }
    return { status, headers };
  }

  private async waitForBytes(length: number): Promise<void> {
    while (this.buffered.length < length) await this.waitForData();
  }

  private async waitForData(): Promise<void> {
    if (this.failure) throw this.failure;
    if (this.ended) throw new RelayV2Error('network-error');
    await new Promise<void>((resolve, reject) => {
      const onData = (): void => {
        cleanup();
        resolve();
      };
      const onError = (error: Error): void => {
        cleanup();
        reject(error);
      };
      const onClose = (): void => {
        cleanup();
        reject(new RelayV2Error('network-error'));
      };
      const cleanup = (): void => {
        this.socket.off('data', onData);
        this.socket.off('error', onError);
        this.socket.off('close', onClose);
      };
      this.socket.once('data', onData);
      this.socket.once('error', onError);
      this.socket.once('close', onClose);
    });
  }
}

async function writeJsonRequest(socket: net.Socket, host: string, pathname: string, body: unknown): Promise<void> {
  const encoded = Buffer.from(JSON.stringify(body), 'utf8');
  await writeRequest(
    socket,
    host,
    'POST',
    pathname,
    [
      ['Content-Type', 'application/json'],
      ['Content-Length', String(encoded.byteLength)],
    ],
    encoded
  );
}

async function writeRequest(
  socket: net.Socket,
  host: string,
  method: string,
  pathname: string,
  headers: ReadonlyArray<readonly [string, string]>,
  body?: Buffer
): Promise<void> {
  const lines = [`${method} ${pathname} HTTP/1.1`, `Host: ${host}`, 'Connection: keep-alive'];
  for (const [name, value] of headers) {
    if (name.toLowerCase() === 'connection') lines[2] = `${name}: ${value}`;
    else lines.push(`${name}: ${value}`);
  }
  const head = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'ascii');
  const output = body ? Buffer.concat([head, body]) : head;
  await new Promise<void>((resolve, reject) => {
    socket.write(output, (error) => (error ? reject(error) : resolve()));
  });
}

function ensureAuthStatus(response: HttpResponse, phase: 'challenge' | 'complete'): void {
  if (response.status === 200) return;
  if (phase === 'challenge' && response.status === 401 && responseError(response) === 'Relay auth challenge rejected') {
    throw new RelayV2Error('replay', response.status);
  }
  if (response.status === 409) throw new RelayV2Error('sequence', response.status);
  throw classifyStatus(response.status, false);
}

function classifyStatus(status: number, authenticated: boolean): RelayV2Error {
  if (!authenticated && (status === 401 || status === 404 || status === 426)) {
    return new RelayV2Error('unsupported-auth', status);
  }
  if (!authenticated && status === 503) return new RelayV2Error('server-auth-failed', status);
  if (status === 408 || status === 410) return new RelayV2Error('freshness', status);
  if (status === 409) return new RelayV2Error('sequence', status);
  if (status === 412) return new RelayV2Error('sequence', status);
  return new RelayV2Error('protocol', status);
}

function responseError(response: HttpResponse): string | undefined {
  try {
    const value = parseStrictJsonObject(response.body);
    return typeof value.error === 'string' ? value.error : undefined;
  } catch {
    return undefined;
  }
}

function validateChallenge(
  value: Record<string, unknown>,
  hello: {
    readonly keyId: string;
    readonly clientNonce: string;
    readonly role: string;
    readonly transport: string;
    readonly method: string;
    readonly resource: string;
    readonly flow: string;
  },
  nowMs: number
): BrowserRelayProofFields {
  assertExactKeys(value, [
    'type',
    'v',
    'keyId',
    'instanceId',
    'sessionId',
    'clientNonce',
    'serverNonce',
    'issuedAtMs',
    'expiresAtMs',
    'role',
    'transport',
    'method',
    'resource',
    'flow',
    'serverProof',
  ]);
  if (value.type !== 'auth.challenge') throw new RelayV2Error('protocol');
  if (value.v !== BROWSER_RELAY_AUTH_VERSION) throw new RelayV2Error('protocol');
  for (const key of ['keyId', 'clientNonce', 'role', 'transport', 'method', 'resource', 'flow'] as const) {
    if (value[key] !== hello[key]) throw new RelayV2Error('protocol');
  }
  const fields: BrowserRelayProofFields = {
    keyId: requireToken(value, 'keyId', 22),
    instanceId: requireEncoded(value, 'instanceId', 22),
    sessionId: requireEncoded(value, 'sessionId', 22),
    clientNonce: requireEncoded(value, 'clientNonce', 43),
    serverNonce: requireEncoded(value, 'serverNonce', 43),
    issuedAtMs: requireInteger(value, 'issuedAtMs'),
    expiresAtMs: requireInteger(value, 'expiresAtMs'),
    role: requireString(value, 'role'),
    transport: requireString(value, 'transport'),
    method: requireString(value, 'method'),
    resource: requireString(value, 'resource'),
    flow: requireString(value, 'flow'),
  };
  requireEncoded(value, 'serverProof', 43);
  const lifetime = fields.expiresAtMs - fields.issuedAtMs;
  if (
    lifetime <= 0 ||
    lifetime > BROWSER_RELAY_CHALLENGE_MAX_LIFETIME_MS ||
    fields.issuedAtMs - nowMs > BROWSER_RELAY_CLOCK_SKEW_MS ||
    nowMs > fields.expiresAtMs
  ) {
    throw new RelayV2Error('freshness');
  }
  return fields;
}

function validateAccept(value: Record<string, unknown>, sessionId: string): void {
  assertExactKeys(value, ['type', 'v', 'sessionId', 'acceptProof']);
  if (value.type !== 'auth.ok') throw new RelayV2Error('protocol');
  if (value.v !== BROWSER_RELAY_AUTH_VERSION || value.sessionId !== sessionId) throw new RelayV2Error('protocol');
  requireEncoded(value, 'acceptProof', 43);
}

function parseStrictJsonObject(body: Buffer): Record<string, unknown> {
  const value = parseStrictJson(body);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RelayV2Error('protocol');
  return value as Record<string, unknown>;
}

function parseStrictJson(body: Buffer): unknown {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new RelayV2Error('protocol');
  }
  const errors: ParseError[] = [];
  const tree = parseTree(source, errors, { allowTrailingComma: false, disallowComments: true });
  if (!tree || errors.length > 0) throw new RelayV2Error('protocol');
  rejectDuplicateJsonKeys(tree);
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new RelayV2Error('protocol');
  }
}

function rejectDuplicateJsonKeys(node: JsonNode): void {
  if (node.type === 'object') {
    const keys = new Set<string>();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value;
      if (typeof key !== 'string' || keys.has(key)) throw new RelayV2Error('protocol');
      keys.add(key);
    }
  }
  for (const child of node.children ?? []) rejectDuplicateJsonKeys(child);
}

function assertExactKeys(value: Record<string, unknown>, required: readonly string[]): void {
  const actual = Object.keys(value);
  if (actual.length !== required.length || required.some((key) => !Object.hasOwn(value, key))) {
    throw new RelayV2Error('protocol');
  }
}

function requireString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== 'string') throw new RelayV2Error('protocol');
  return field;
}

function requireEncoded(value: Record<string, unknown>, key: string, length: number): string {
  const field = requireString(value, key);
  const bytes = length === 22 ? 16 : length === 43 ? 32 : 0;
  const decoded = Buffer.from(field, 'base64url');
  if (
    bytes === 0 ||
    field.length !== length ||
    !/^[A-Za-z0-9_-]+$/u.test(field) ||
    decoded.byteLength !== bytes ||
    decoded.toString('base64url') !== field
  ) {
    throw new RelayV2Error('protocol');
  }
  return field;
}

function requireToken(value: Record<string, unknown>, key: string, length: number): string {
  const field = requireString(value, key);
  if (field.length !== length || !/^[A-Za-z0-9_-]+$/u.test(field)) throw new RelayV2Error('protocol');
  return field;
}

function requireInteger(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== 'number' || !Number.isSafeInteger(field)) throw new RelayV2Error('protocol');
  return field;
}

function hasToken(value: string | undefined, expected: string): boolean {
  return Boolean(value?.split(',').some((token) => token.trim().toLowerCase() === expected));
}

function isTimeoutError(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as { reason?: unknown }).reason === 'timeout');
}
