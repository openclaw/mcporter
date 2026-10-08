import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleDoctorCommand } from '../src/cli/config/doctor.js';
import type { LoadConfigOptions } from '../src/config.js';
import * as configModule from '../src/config.js';
import { getOAuthVaultPath } from '../src/oauth-vault.js';
import { sealVaultSecret, vaultSecretKid } from '../src/oauth-vault-encryption.js';

let tempDir: string;
let loadOptions: LoadConfigOptions;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-doctor-'));
  loadOptions = { rootDir: tempDir };
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('config doctor', () => {
  it.each(['flag', 'environment'])('reports the selected %s config path', async (source) => {
    const configPath = path.join(tempDir, 'custom.json');
    await fs.writeFile(configPath, '{"mcpServers":{},"imports":[]}');
    if (source === 'flag') {
      loadOptions = { ...loadOptions, configPath };
      vi.stubEnv('MCPORTER_CONFIG', path.join(tempDir, 'overridden.json'));
    } else {
      vi.stubEnv('MCPORTER_CONFIG', configPath);
    }
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleDoctorCommand({ loadOptions } as never, []);
    const lines = logSpy.mock.calls.flat().join('\n');
    expect(lines).toContain(`Selected config: ${configPath}`);
    expect(lines).not.toContain(`Selected config: ${configPath} (missing)`);
    expect(lines).toContain('Config looks good.');
  });

  it('reports issues for stdio cwd and missing oauth token cache', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(configModule, 'loadConfigSnapshot').mockResolvedValue({
      servers: [
        {
          name: 'bad-stdio',
          command: { kind: 'stdio', command: 'node', args: [], cwd: 'relative/path' },
        },
        {
          name: 'oauth-missing-cache',
          command: { kind: 'http', url: new URL('https://example.com/mcp'), headers: {} },
          auth: 'oauth',
          tokenCacheDir: undefined,
        },
      ],
      daemon: {},
      vaultEncryption: undefined,
    });

    await handleDoctorCommand({ loadOptions } as never, []);

    const output = logSpy.mock.calls.flat().join('\n');
    logSpy.mockRestore();

    expect(output).toContain('has a non-absolute working directory');
  });
});

const runDoctor = async () => {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  await handleDoctorCommand({ loadOptions } as never, []);
  return spy.mock.calls.flat().join('\n');
};
const writeVaultFile = async (text: string) => {
  await fs.mkdir(path.dirname(getOAuthVaultPath()), { recursive: true });
  await fs.writeFile(getOAuthVaultPath(), text, 'utf8');
};

describe('config doctor vault state', () => {
  const PASSWORD = 'doctor-vault-password-0123456789';
  const KEY = 'api|0123456789abcdef';
  const vault = (refresh: string) =>
    JSON.stringify({
      version: 2,
      entries: {
        [KEY]: {
          serverName: 'api',
          updatedAt: 'now',
          tokens: { access_token: 'plain', refresh_token: refresh, token_type: 'Bearer' },
        },
      },
    });
  afterEach(async () => {
    await fs.rm(getOAuthVaultPath(), { force: true });
  });

  it('reports an absent vault', async () => {
    const out = await runDoctor();
    expect(out).toContain(`OAuth vault: ${getOAuthVaultPath()} (absent)`);
    expect(out).toContain('Vault encryption: policy optional, MCPORTER_VAULT_PASSWORD unset');
    expect(out).toContain('Config looks good.');
  });
  it('counts values without the password and flags the missing password', async () => {
    await writeVaultFile(
      vault(await sealVaultSecret('rt', vaultSecretKid(KEY, ['tokens', 'refresh_token']), PASSWORD))
    );
    const out = await runDoctor();
    expect(out).toContain('(1 entries, 1 sealed values, 1 plaintext values)');
    expect(out).toContain('MCPORTER_VAULT_PASSWORD is unset');
  });
  it('flags plaintext values when a password is set', async () => {
    await writeVaultFile(vault('plain-refresh'));
    vi.stubEnv('MCPORTER_VAULT_PASSWORD', PASSWORD);
    expect(await runDoctor()).toContain('sealed on the next vault write');
  });
  it('applies the configured policy', async () => {
    await writeVaultFile(vault('plain-refresh'));
    vi.spyOn(configModule, 'loadConfigSnapshot').mockResolvedValue({
      servers: [],
      daemon: {},
      vaultEncryption: 'required',
    });
    vi.stubEnv('MCPORTER_VAULT_PASSWORD', PASSWORD);
    const out = await runDoctor();
    expect(out).toContain('policy required');
    expect(out).toContain('under oauthVaultEncryption');
  });
  it('reports a vault that is valid JSON but not a vault document as unreadable', async () => {
    for (const body of ['null', '[]', '"text"', '{"version":2,"entries":7}']) {
      await writeVaultFile(body);
      const out = await runDoctor();
      expect(out, body).toContain('(unreadable)');
      expect(out, body).toContain('not a valid OAuth vault');
    }
  });
  it('reports unreadable vaults and settings errors as issues', async () => {
    await writeVaultFile('{"version":1,"entries": { bad');
    expect(await runDoctor()).toContain('(unreadable)');
    vi.stubEnv('MCPORTER_VAULT_ENCRYPTION', 'required');
    expect(await runDoctor()).toContain('MCPORTER_VAULT_ENCRYPTION=required but MCPORTER_VAULT_PASSWORD is not set');
  });
});
