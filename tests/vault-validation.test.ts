import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleVault } from '../src/cli/vault-command.js';
import type { ServerDefinition } from '../src/config.js';

const definition: ServerDefinition = {
  name: 'calendar',
  command: { kind: 'http', url: new URL('https://calendar.example/mcp') },
};
const runtime = { getDefinition: () => definition };
const stdin = (value: unknown) => ({ readStdin: async () => JSON.stringify(value) });

describe('vault command input validation', () => {
  const originalDataHome = process.env.XDG_DATA_HOME;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-vault-validation-'));
    process.env.XDG_DATA_HOME = tempDir;
  });

  afterEach(async () => {
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
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
    [
      { tokens: { access_token: 'token', token_type: 'Bearer' }, clientInfo: [] },
      "Vault payload 'clientInfo' must be an object",
    ],
    [
      { tokens: { access_token: 'token', token_type: 'Bearer' }, clientInfo: { client_id: 42 } },
      'clientInfo.client_id must be a string',
    ],
    [
      { tokens: { access_token: 'token', token_type: 'Bearer' }, clientInfo: { application_type: 42 } },
      'clientInfo.application_type must be a string',
    ],
    [
      { tokens: { access_token: 'token', token_type: 'Bearer' }, clientInfo: { redirect_uris: 'callback' } },
      'clientInfo.redirect_uris must be an array of strings',
    ],
    [
      { tokens: { access_token: 'token', token_type: 'Bearer' }, clientInfo: { grant_types: ['code', 42] } },
      'clientInfo.grant_types must be an array of strings',
    ],
    [
      { tokens: { access_token: 'token', token_type: 'Bearer' }, clientInfo: { client_id_issued_at: 'today' } },
      'clientInfo.client_id_issued_at must be a finite number',
    ],
  ])('rejects malformed payload %#', async (payload, message) => {
    await expect(handleVault(runtime, ['set', 'calendar', '--stdin'], stdin(payload))).rejects.toThrow(
      message as string
    );
  });
});
