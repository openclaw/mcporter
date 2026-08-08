import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleVault } from '../src/cli/vault-command.js';
import type { ServerDefinition } from '../src/config.js';
import { loadVaultEntry } from '../src/oauth-vault.js';

const definition: ServerDefinition = {
  name: 'calendar',
  command: { kind: 'http', url: new URL('https://calendar.example/mcp') },
};
const runtime = { getDefinition: () => definition };
const stdin = (value: unknown) => ({ readStdin: async () => JSON.stringify(value) });
const tokens = { access_token: 'token', token_type: 'Bearer' };

const seed = (payload: unknown) => handleVault(runtime, ['set', 'calendar', '--stdin'], stdin(payload));

describe('vault command input validation', () => {
  const originalDataHome = process.env.XDG_DATA_HOME;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-vault-validation-'));
    process.env.XDG_DATA_HOME = tempDir;
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(async () => {
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it.each([
    [[], 'Usage: mcporter vault <set|clear>'],
    [['set'], 'Usage: mcporter vault set <server>'],
    [['clear'], 'Usage: mcporter vault clear <server>'],
    [['clear', 'calendar', 'extra'], "Unknown vault clear argument 'extra'"],
    [['set', 'calendar'], 'Usage: mcporter vault set <server>'],
    [['set', 'calendar', '--stdin', '--tokens-file', 'tokens.json'], "Use either '--tokens-file' or '--stdin'"],
    [['set', 'calendar', '--tokens-file'], "Flag '--tokens-file' requires a path"],
    [['set', 'calendar', '--stdin', 'extra'], "Unknown vault set argument 'extra'"],
  ])('rejects invalid command arguments %#', async (args, message) => {
    await expect(handleVault(runtime, [...(args as string[])] as string[], stdin({}))).rejects.toThrow(
      message as string
    );
  });

  it.each([
    [null, 'Vault payload must be a JSON object'],
    [{ tokens: [] }, "Vault payload must include a 'tokens' object"],
    [{ tokens: { access_token: '', token_type: 'Bearer' } }, 'tokens.access_token must be a non-empty string'],
    [{ tokens: { access_token: 'token', token_type: '' } }, 'tokens.token_type must be a non-empty string'],
    [
      { tokens: { access_token: 'token', token_type: 'Bearer', refresh_token: 42 } },
      'tokens.refresh_token must be a string',
    ],
    [
      { tokens: { access_token: 'token', token_type: 'Bearer', expires_in: Number.POSITIVE_INFINITY } },
      'tokens.expires_in must be a finite number',
    ],
    [{ tokens, clientInfo: [] }, "Vault payload 'clientInfo' must be an object"],
    [{ tokens, clientInfo: { client_id: 42 } }, 'clientInfo.client_id must be a non-empty string'],
  ])('rejects malformed payload %#', async (payload, message) => {
    await expect(handleVault(runtime, ['set', 'calendar', '--stdin'], stdin(payload))).rejects.toThrow(
      message as string
    );
  });

  it('accepts a dynamic client registration clientInfo payload', async () => {
    const clientInfo = {
      client_id: 'abc',
      redirect_uris: ['https://example.test/cb'],
      grant_types: ['authorization_code'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };

    await seed({ tokens, clientInfo });

    await expect(loadVaultEntry(definition)).resolves.toMatchObject({ tokens, clientInfo });
  });

  it('accepts registration timestamps, contacts, and a jwks document', async () => {
    const clientInfo = {
      client_id: 'abc',
      client_secret: 'secret',
      client_id_issued_at: 1_754_600_000,
      client_secret_expires_at: 0,
      contacts: ['ops@example.test'],
      jwks: { keys: [{ kty: 'RSA', n: 'abc', e: 'AQAB' }] },
    };

    await seed({ tokens, clientInfo });

    await expect(loadVaultEntry(definition)).resolves.toMatchObject({ tokens, clientInfo });
  });

  it('preserves unknown clientInfo fields and seeded token expiry', async () => {
    const payload = {
      tokens: { ...tokens, expires_in: 3600, expires_at: 1_754_600_000, id_token: 'id-token' },
      clientInfo: {
        client_id: 'abc',
        registration_client_uri: 'https://example.test/register/abc',
        registration_access_token: 'registration-token',
      },
    };

    await seed(payload);

    await expect(loadVaultEntry(definition)).resolves.toMatchObject(payload);
  });

  it('treats null clientInfo fields as absent', async () => {
    const clientInfo = { client_id: 'abc', client_secret: null, redirect_uris: null };

    await seed({ tokens, clientInfo });

    await expect(loadVaultEntry(definition)).resolves.toMatchObject({ clientInfo });
  });

  it.each([
    [{ client_id: 'abc', redirect_uris: ['https://example.test/cb', 42] }, 'redirect_uris must be an array of strings'],
    [{ client_id: 'abc', redirect_uris: 'https://example.test/cb' }, 'redirect_uris must be an array of strings'],
    [{ client_id: 'abc', grant_types: 'authorization_code' }, 'grant_types must be an array of strings'],
    [{ client_id: 'abc', client_id_issued_at: 'yesterday' }, 'client_id_issued_at must be a finite number'],
    [{ client_id: 'abc', client_secret_expires_at: 'never' }, 'client_secret_expires_at must be a finite number'],
    [{ client_id: 'abc', client_name: 42 }, 'client_name must be a string'],
    [{}, 'clientInfo.client_id must be a non-empty string'],
  ])('rejects malformed clientInfo %#', async (clientInfo, message) => {
    await expect(seed({ tokens, clientInfo })).rejects.toThrow(message as string);
  });
});
