import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export const BROWSER_RELAY_AUTH_LABEL = 'openclaw.browser-relay.auth';
export const BROWSER_RELAY_AUTH_VERSION = 2;
export const BROWSER_RELAY_CHALLENGE_MAX_LIFETIME_MS = 10_000;
export const BROWSER_RELAY_CLOCK_SKEW_MS = 30_000;
export const BROWSER_RELAY_AUTH_CHALLENGE_PATH = '/_openclaw/relay/auth/v2/challenge';
export const BROWSER_RELAY_AUTH_COMPLETE_PATH = '/_openclaw/relay/auth/v2/complete';
export const BROWSER_RELAY_CDP_PATH = '/cdp';
export const BROWSER_RELAY_CDP_ROLE = 'cdp';
export const BROWSER_RELAY_CDP_TRANSPORT = 'connection';
export const BROWSER_RELAY_CDP_METHOD = 'SEQUENCE';
export const BROWSER_RELAY_CDP_RESOURCE = '/json/version -> /cdp';
export const BROWSER_RELAY_CDP_FLOW = 'cdp';
export const BROWSER_RELAY_VERSION_PATH = '/json/version';

export type BrowserRelayProofKind = 'server' | 'client' | 'accept';

export interface BrowserRelayProofFields {
  readonly keyId: string;
  readonly instanceId: string;
  readonly sessionId: string;
  readonly clientNonce: string;
  readonly serverNonce: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly role: string;
  readonly transport: string;
  readonly method: string;
  readonly resource: string;
  readonly flow: string;
}

export function deriveBrowserRelayKeyId(key: Uint8Array): string {
  assertRelayKey(key);
  return createHash('sha256').update(key).digest('base64url').slice(0, 22);
}

export function canonicalizeBrowserRelayProof(
  proofKind: BrowserRelayProofKind,
  fields: BrowserRelayProofFields,
  clientProof?: string
): Buffer {
  const canonical: Array<string | number> = [
    BROWSER_RELAY_AUTH_LABEL,
    BROWSER_RELAY_AUTH_VERSION,
    proofKind,
    fields.keyId,
    fields.instanceId,
    fields.sessionId,
    fields.clientNonce,
    fields.serverNonce,
    fields.issuedAtMs,
    fields.expiresAtMs,
    fields.role,
    fields.transport,
    fields.method,
    fields.resource,
    fields.flow,
  ];
  if (proofKind === 'accept') {
    if (!clientProof || !isCanonicalBase64Url(clientProof, 32)) {
      throw new Error('Browser relay accept proof requires a 32-byte client proof.');
    }
    canonical.push(clientProof);
  } else if (clientProof !== undefined) {
    throw new Error('Browser relay client proof is only valid for an accept proof.');
  }
  return Buffer.from(JSON.stringify(canonical), 'utf8');
}

export function createBrowserRelayProof(
  key: Uint8Array,
  proofKind: BrowserRelayProofKind,
  fields: BrowserRelayProofFields,
  clientProof?: string
): string {
  assertRelayKey(key);
  return createHmac('sha256', key)
    .update(canonicalizeBrowserRelayProof(proofKind, fields, clientProof))
    .digest('base64url');
}

export function verifyBrowserRelayProof(
  key: Uint8Array,
  proofKind: BrowserRelayProofKind,
  fields: BrowserRelayProofFields,
  proof: string,
  clientProof?: string
): boolean {
  if (!isCanonicalBase64Url(proof, 32)) return false;
  const actual = Buffer.from(proof, 'base64url');
  const expected = Buffer.from(createBrowserRelayProof(key, proofKind, fields, clientProof), 'base64url');
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

function assertRelayKey(key: Uint8Array): void {
  if (key.byteLength !== 32) throw new Error('Browser relay key must contain 32 bytes.');
}

function isCanonicalBase64Url(value: string, bytes: number): boolean {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.byteLength === bytes && decoded.toString('base64url') === value;
}
