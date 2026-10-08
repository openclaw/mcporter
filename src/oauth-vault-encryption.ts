import { CompactEncrypt, compactDecrypt, decodeProtectedHeader, errors as joseErrors } from 'jose';
import type { VaultEncryptionPolicy } from './config-schema.js';

export type { VaultEncryptionPolicy };

export const VAULT_PASSWORD_ENV = 'MCPORTER_VAULT_PASSWORD';
export const VAULT_ENCRYPTION_POLICY_ENV = 'MCPORTER_VAULT_ENCRYPTION';
export const VAULT_SECRET_ENV_NAMES = [VAULT_PASSWORD_ENV, VAULT_ENCRYPTION_POLICY_ENV] as const;
export const VAULT_JWE_ALG = 'PBES2-HS512+A256KW';
export const VAULT_JWE_ENC = 'A256GCM';
// RFC 7516 §4.1.11: tells vault ciphertext apart from any other string.
export const VAULT_JWE_TYP = 'mcporter-vault+jwe';
// 99designs/keyring default (about 2 ms per value); readers accept up to the ceiling.
export const VAULT_PBES2_ITERATIONS = 8192;
export const VAULT_PBES2_MAX_ITERATIONS = 100_000;
export const MIN_VAULT_PASSWORD_LENGTH = 16;
// The only values ever sealed; a test checks this list against VaultEntry.
export const VAULT_SECRET_FIELDS: readonly (readonly string[])[] = [
  ['tokens', 'access_token'],
  ['tokens', 'refresh_token'],
  ['clientInfo', 'client_secret'],
  ['codeVerifier'],
  ['state'],
];

export type VaultEncryptionErrorCode =
  | 'password_missing'
  | 'password_invalid'
  | 'policy_invalid'
  | 'decrypt_failed'
  | 'payload_invalid';

export class VaultEncryptionError extends Error {
  constructor(
    readonly code: VaultEncryptionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'VaultEncryptionError';
  }
}

export interface VaultEncryptionSettings {
  readonly policy: VaultEncryptionPolicy;
  readonly password: string | undefined;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const COMPACT_JWE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function readPassword(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  if (value.length < MIN_VAULT_PASSWORD_LENGTH) {
    throw new VaultEncryptionError(
      'password_invalid',
      `${name} must be at least ${MIN_VAULT_PASSWORD_LENGTH} characters; generate one with \`openssl rand -base64 32\`.`
    );
  }
  return value;
}

export function readVaultEncryptionSettings(
  env: NodeJS.ProcessEnv = process.env,
  configuredPolicy?: VaultEncryptionPolicy
): VaultEncryptionSettings {
  const raw = (env[VAULT_ENCRYPTION_POLICY_ENV] ?? '').trim().toLowerCase();
  if (raw !== '' && raw !== 'optional' && raw !== 'required') {
    throw new VaultEncryptionError(
      'policy_invalid',
      `${VAULT_ENCRYPTION_POLICY_ENV} must be 'optional' or 'required'.`
    );
  }
  // The env var wins when set; otherwise the config key (validated by RawConfigSchema); otherwise optional.
  const policy: VaultEncryptionPolicy = raw !== '' ? (raw as VaultEncryptionPolicy) : (configuredPolicy ?? 'optional');
  const password = readPassword(env, VAULT_PASSWORD_ENV);
  if (policy === 'required' && password === undefined) {
    throw new VaultEncryptionError(
      'password_missing',
      `${raw !== '' ? `${VAULT_ENCRYPTION_POLICY_ENV}=required` : 'oauthVaultEncryption is "required"'} but ${VAULT_PASSWORD_ENV} is not set; the OAuth vault cannot be used.`
    );
  }
  return { policy, password };
}

// Spawned children have no use for the vault password.
export function childEnvWithoutVaultSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy: NodeJS.ProcessEnv = { ...env };
  for (const name of VAULT_SECRET_ENV_NAMES) delete copy[name];
  return copy;
}

export function vaultSecretKid(vaultKey: string, path: readonly string[]): string {
  return `${vaultKey}/${path.join('/')}`;
}

function header(token: unknown): ReturnType<typeof decodeProtectedHeader> | undefined {
  if (typeof token !== 'string' || !COMPACT_JWE.test(token)) return undefined;
  try {
    return decodeProtectedHeader(token);
  } catch {
    return undefined;
  }
}

export function isVaultSecretJwe(value: unknown): value is string {
  return header(value)?.typ === VAULT_JWE_TYP;
}

export async function sealVaultSecret(plaintext: string, kid: string, password: string): Promise<string> {
  const token = await new CompactEncrypt(encoder.encode(plaintext))
    .setProtectedHeader({ alg: VAULT_JWE_ALG, enc: VAULT_JWE_ENC, typ: VAULT_JWE_TYP, kid })
    .setKeyManagementParameters({ p2c: VAULT_PBES2_ITERATIONS })
    .encrypt(encoder.encode(password));
  // Verified write: a codec regression can never persist an unreadable value.
  if ((await openVaultSecret(token, kid, password)) !== plaintext) {
    throw new VaultEncryptionError('payload_invalid', `OAuth vault self-check failed for ${kid}; nothing was written.`);
  }
  return token;
}

async function openWith(token: string, password: string): Promise<string | undefined> {
  try {
    const { plaintext } = await compactDecrypt(token, encoder.encode(password), {
      keyManagementAlgorithms: [VAULT_JWE_ALG],
      contentEncryptionAlgorithms: [VAULT_JWE_ENC],
      maxPBES2Count: VAULT_PBES2_MAX_ITERATIONS,
    });
    return decoder.decode(plaintext);
  } catch (error) {
    if (error instanceof joseErrors.JWEDecryptionFailed) return undefined;
    if (error instanceof joseErrors.JOSEError) {
      throw new VaultEncryptionError(
        'payload_invalid',
        'An OAuth vault value is not a JWE mcporter can read; refusing to use it.'
      );
    }
    throw error;
  }
}

export async function openVaultSecret(token: string, kid: string, password: string): Promise<string> {
  // Everything about the envelope is decided from the header before a PBKDF2 round.
  const h = header(token);
  if (
    !h ||
    h.alg !== VAULT_JWE_ALG ||
    h.enc !== VAULT_JWE_ENC ||
    h.typ !== VAULT_JWE_TYP ||
    typeof h.p2c !== 'number' ||
    h.p2c < 1 ||
    h.p2c > VAULT_PBES2_MAX_ITERATIONS
  ) {
    throw new VaultEncryptionError(
      'payload_invalid',
      `OAuth vault value ${kid} is not in the vault JWE profile; refusing to use it.`
    );
  }
  if (h.kid !== kid) {
    throw new VaultEncryptionError(
      'payload_invalid',
      `OAuth vault value ${kid} carries another identity; refusing to use it.`
    );
  }
  const value = await openWith(token, password);
  if (value !== undefined) return value;
  throw new VaultEncryptionError(
    'decrypt_failed',
    `Cannot decrypt OAuth vault value ${kid} with ${VAULT_PASSWORD_ENV}; the file was left untouched.`
  );
}

export function readPath(node: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>(
    (cur, key) => (cur && typeof cur === 'object' ? (cur as Record<string, unknown>)[key] : undefined),
    node
  );
}

export function describeVaultSecrets(entries: unknown): { entries: number; sealed: number; plaintext: number } {
  const stats = { entries: 0, sealed: 0, plaintext: 0 };
  if (!entries || typeof entries !== 'object') return stats;
  for (const entry of Object.values(entries as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || typeof (entry as { serverName?: unknown }).serverName !== 'string')
      continue;
    stats.entries += 1;
    for (const path of VAULT_SECRET_FIELDS) {
      const value = readPath(entry, path);
      if (typeof value !== 'string') continue;
      if (isVaultSecretJwe(value)) stats.sealed += 1;
      else stats.plaintext += 1;
    }
  }
  return stats;
}
