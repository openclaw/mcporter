import crypto from 'node:crypto';
import { CompactEncrypt, SignJWT, decodeProtectedHeader } from 'jose';
import { describe, expect, it } from 'vitest';
import type { VaultEntry } from '../src/oauth-vault.js';
import {
  MIN_VAULT_PASSWORD_LENGTH,
  VAULT_JWE_ALG,
  VAULT_JWE_ENC,
  VAULT_JWE_TYP,
  VAULT_PBES2_ITERATIONS,
  VAULT_PBES2_MAX_ITERATIONS,
  VAULT_SECRET_FIELDS,
  VaultEncryptionError,
  childEnvWithoutVaultSecrets,
  describeVaultSecrets,
  isVaultSecretJwe,
  openVaultSecret,
  readVaultEncryptionSettings,
  sealVaultSecret,
  vaultSecretKid,
} from '../src/oauth-vault-encryption.js';

const PASSWORD = 'correct-horse-battery-staple-2026';
const OTHER = 'another-password-that-is-long-enough';
const KID = vaultSecretKid('linear|3f9c2a7d1b4e8f60', ['tokens', 'refresh_token']);

// Flip a tag character, not the last ciphertext character: that one can carry
// padding bits decoders ignore (11 of 300 tampered tokens decrypted in a trial).
const tamper = (token: string) => {
  const p = token.split('.');
  p[4] = `${p[4]?.[0] === 'A' ? 'B' : 'A'}${p[4]?.slice(1) ?? ''}`;
  return p.join('.');
};
const foreign = async (header: Record<string, unknown>, key: Uint8Array, p2c?: number) => {
  const b = new CompactEncrypt(new TextEncoder().encode('lin_rt_EXAMPLE')).setProtectedHeader(header as never);
  if (p2c !== undefined) b.setKeyManagementParameters({ p2c });
  return await b.encrypt(key);
};

describe('readVaultEncryptionSettings', () => {
  it('defaults to optional', () => {
    expect(readVaultEncryptionSettings({})).toEqual({ policy: 'optional', password: undefined });
  });
  it('normalizes the policy and rejects unknown values', () => {
    expect(
      readVaultEncryptionSettings({ MCPORTER_VAULT_ENCRYPTION: ' Required ', MCPORTER_VAULT_PASSWORD: PASSWORD }).policy
    ).toBe('required');
    expect(() => readVaultEncryptionSettings({ MCPORTER_VAULT_ENCRYPTION: 'always' })).toThrowError(
      expect.objectContaining({
        name: 'VaultEncryptionError',
        code: 'policy_invalid',
        message: expect.stringContaining('optional'),
      })
    );
  });
  it('requires a password under required, from env or config', () => {
    expect(() => readVaultEncryptionSettings({ MCPORTER_VAULT_ENCRYPTION: 'required' })).toThrowError(
      expect.objectContaining({ code: 'password_missing', message: expect.stringContaining('MCPORTER_VAULT_PASSWORD') })
    );
    expect(() => readVaultEncryptionSettings({}, 'required')).toThrowError(
      expect.objectContaining({ code: 'password_missing' })
    );
  });
  it('lets the env var override the configured policy', () => {
    expect(readVaultEncryptionSettings({ MCPORTER_VAULT_ENCRYPTION: 'optional' }, 'required').policy).toBe('optional');
    expect(readVaultEncryptionSettings({ MCPORTER_VAULT_PASSWORD: PASSWORD }, 'required').policy).toBe('required');
  });
  it.each(['', 'short'])('rejects password %j without echoing it', (value) => {
    expect(() => readVaultEncryptionSettings({ MCPORTER_VAULT_PASSWORD: value })).toThrowError(
      expect.objectContaining({
        code: 'password_invalid',
        message: expect.stringContaining(String(MIN_VAULT_PASSWORD_LENGTH)),
      })
    );
    expect(() => readVaultEncryptionSettings({ MCPORTER_VAULT_PASSWORD: value })).toThrowError(
      expect.objectContaining({ message: expect.not.stringContaining(value || 'never') })
    );
  });
});

describe('seal / open', () => {
  it('round-trips with the expected header', async () => {
    const token = await sealVaultSecret('lin_rt_EXAMPLE', KID, PASSWORD);
    expect(isVaultSecretJwe(token)).toBe(true);
    expect(decodeProtectedHeader(token)).toMatchObject({
      alg: VAULT_JWE_ALG,
      enc: VAULT_JWE_ENC,
      typ: VAULT_JWE_TYP,
      kid: KID,
      p2c: VAULT_PBES2_ITERATIONS,
    });
    await expect(openVaultSecret(token, KID, PASSWORD)).resolves.toBe('lin_rt_EXAMPLE');
    expect(await sealVaultSecret('x'.repeat(8), KID, PASSWORD)).not.toBe(
      await sealVaultSecret('x'.repeat(8), KID, PASSWORD)
    );
  });
  it('fails closed on a wrong password and refuses tampering', async () => {
    const token = await sealVaultSecret('lin_rt_EXAMPLE', KID, PASSWORD);
    const err = await openVaultSecret(token, KID, OTHER).then(
      () => {
        throw new Error('expected rejection');
      },
      (e: unknown) => e as VaultEncryptionError
    );
    expect(err).toBeInstanceOf(VaultEncryptionError);
    expect(err.code).toBe('decrypt_failed');
    for (const s of [PASSWORD, OTHER, 'lin_rt_EXAMPLE']) expect(err.message).not.toContain(s);
    await expect(openVaultSecret(tamper(token), KID, PASSWORD)).rejects.toMatchObject({ code: 'decrypt_failed' });
  });
  it('refuses relocated and foreign tokens from the header, before key derivation', async () => {
    const pw = new TextEncoder().encode(PASSWORD);
    const moved = await sealVaultSecret('lin_rt_EXAMPLE', KID, PASSWORD);
    const otherKid = vaultSecretKid('linear|3f9c2a7d1b4e8f60', ['tokens', 'access_token']);
    for (const token of [
      moved,
      await foreign({ alg: 'dir', enc: 'A256GCM', typ: VAULT_JWE_TYP, kid: otherKid }, crypto.randomBytes(32)),
      await foreign({ alg: VAULT_JWE_ALG, enc: VAULT_JWE_ENC, kid: otherKid }, pw, VAULT_PBES2_ITERATIONS),
      await foreign(
        { alg: VAULT_JWE_ALG, enc: VAULT_JWE_ENC, typ: VAULT_JWE_TYP, kid: otherKid },
        pw,
        VAULT_PBES2_MAX_ITERATIONS + 1
      ),
    ]) {
      await expect(openVaultSecret(token, otherKid, OTHER)).rejects.toMatchObject({ code: 'payload_invalid' });
    }
  });
  it('round-trips non-ASCII', async () => {
    const pw = 'пароль-très-sécurisé-日本語-2026';
    await expect(openVaultSecret(await sealVaultSecret('секрет-🔑', KID, pw), KID, pw)).resolves.toBe('секрет-🔑');
  });
});

describe('isVaultSecretJwe', () => {
  it('accepts sealed values only', async () => {
    expect(isVaultSecretJwe(await sealVaultSecret('v', KID, PASSWORD))).toBe(true);
    expect(isVaultSecretJwe('lin_rt_EXAMPLE')).toBe(false);
    expect(isVaultSecretJwe(undefined)).toBe(false);
    expect(
      isVaultSecretJwe(
        await new SignJWT({ sub: 'x' }).setProtectedHeader({ alg: 'HS256' }).sign(crypto.randomBytes(32))
      )
    ).toBe(false);
    expect(isVaultSecretJwe(await foreign({ alg: 'dir', enc: 'A256GCM', typ: 'at+jwe' }, crypto.randomBytes(32)))).toBe(
      false
    );
  });
});

describe('childEnvWithoutVaultSecrets', () => {
  it('removes the vault variables and nothing else', () => {
    expect(
      childEnvWithoutVaultSecrets({
        PATH: '/bin',
        MCPORTER_VAULT_PASSWORD: PASSWORD,
        MCPORTER_VAULT_ENCRYPTION: 'required',
      })
    ).toEqual({ PATH: '/bin' });
  });
});

describe('VAULT_SECRET_FIELDS and describeVaultSecrets', () => {
  it('names string fields of VaultEntry and counts them', async () => {
    const entry: VaultEntry = {
      serverName: 'x',
      updatedAt: 'now',
      tokens: { access_token: 'a', refresh_token: 'r', token_type: 'Bearer' },
      clientInfo: { client_id: 'c', client_secret: 's' },
      codeVerifier: 'v',
      state: 's',
    };
    for (const path of VAULT_SECRET_FIELDS) {
      expect(
        typeof path.reduce<unknown>((n, k) => (n as Record<string, unknown> | undefined)?.[k], entry),
        path.join('/')
      ).toBe('string');
    }
    const sealed = await sealVaultSecret('r', KID, PASSWORD);
    expect(
      describeVaultSecrets({
        a: {
          serverName: 'a',
          updatedAt: 'now',
          tokens: { access_token: 'plain', refresh_token: sealed, token_type: 'Bearer' },
        },
        b: { serverName: 'b', updatedAt: 'now' },
        c: 'not an entry',
      })
    ).toEqual({ entries: 2, sealed: 1, plaintext: 1 });
  });
});
