import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { loadVaultEntry } from '../src/oauth-vault.js';

const CLI_ENTRY = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const SERVER_URL = 'https://example.test/mcp';
const definition: ServerDefinition = {
  name: 'demo',
  command: { kind: 'http', url: new URL(SERVER_URL) },
  auth: 'oauth',
};

interface CliResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

describe('built vault CLI input boundary', () => {
  const originalDataHome = process.env.XDG_DATA_HOME;
  let configPath: string;
  let dataHome: string;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-vault-cli-'));
    dataHome = path.join(tempDir, 'data');
    configPath = path.join(tempDir, 'mcporter.json');
    process.env.XDG_DATA_HOME = dataHome;
    await fs.writeFile(
      configPath,
      JSON.stringify({ imports: [], mcpServers: { demo: { baseUrl: SERVER_URL, auth: 'oauth' } } }),
      'utf8'
    );
  });

  afterEach(async () => {
    if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalDataHome;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('does not echo malformed credential input through parser diagnostics', async () => {
    const marker = 'VAULT_SECRET_MARKER_7H3K9';
    const result = await runVault(['--stdin'], `${marker} malformed`);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.exitCode).not.toBe(0);
    expect(output).toContain('Vault payload from stdin is not valid JSON.');
    expect(output).not.toContain(marker);
    expect(output).not.toContain('VAULT_SECR');
    expect(output).not.toContain('SyntaxError');
    expect(output).not.toContain('Unexpected token');
  });

  it('names a malformed credential file without echoing its contents', async () => {
    const marker = 'VAULT_FILE_SECRET_MARKER_2Q8M4';
    const payloadPath = path.join(tempDir, 'tokens.json');
    await fs.writeFile(payloadPath, `${marker} malformed`, 'utf8');
    const result = await runVault(['--tokens-file', payloadPath]);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.exitCode).not.toBe(0);
    expect(output).toContain(`Vault payload file '${payloadPath}' is not valid JSON.`);
    expect(output).not.toContain(marker);
    expect(output).not.toContain('VAULT_FILE_SECR');
    expect(output).not.toContain('SyntaxError');
  });

  it.each([
    ['expires_at string', JSON.stringify(payload({ expires_at: 'soon' })), 'tokens.expires_at'],
    ['expiresAt string', JSON.stringify(payload({ expiresAt: 'soon' })), 'tokens.expiresAt'],
    ['expires_at positive infinity', rawPayload('expires_at', '1e999'), 'tokens.expires_at'],
    ['expiresAt negative infinity', rawPayload('expiresAt', '-1e999'), 'tokens.expiresAt'],
  ])('rejects invalid %s', async (_name, input, field) => {
    const result = await runVault(['--stdin'], input);
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain(`${field} must be a finite number`);
  });

  it('rejects a JSON NaN literal at the sanitized parse boundary', async () => {
    const result = await runVault(['--stdin'], rawPayload('expires_at', 'NaN'));
    expect(result.exitCode).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('Vault payload from stdin is not valid JSON.');
  });

  it.each([
    ['expires_at', 0],
    ['expiresAt', 1_754_600_000.5],
  ] as const)('persists finite %s values and unrelated valid credential fields', async (field, value) => {
    const input = {
      tokens: {
        access_token: 'fake-access-token',
        token_type: 'Bearer',
        refresh_token: 'fake-refresh-token',
        scope: 'read write',
        issuer: 'https://issuer.example',
        expires_in: 3600.25,
        [field]: value,
        id_token: 'fake-id-token',
      },
      clientInfo: {
        client_id: 'fake-client',
        redirect_uris: ['https://example.test/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        client_name: null,
        provider_metadata: { tenant: 'demo' },
      },
    };

    const result = await runVault(['--stdin'], JSON.stringify(input));
    expect(result.exitCode, result.stderr).toBe(0);
    await expect(loadVaultEntry(definition)).resolves.toMatchObject(input);
  });

  async function runVault(sourceArgs: string[], input?: string): Promise<CliResult> {
    const home = path.join(tempDir, 'home');
    await fs.mkdir(home, { recursive: true });
    return new Promise<CliResult>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [CLI_ENTRY, '--config', configPath, 'vault', 'set', 'demo', ...sourceArgs],
        {
          cwd: tempDir,
          env: {
            ...process.env,
            HOME: home,
            XDG_CONFIG_HOME: path.join(home, 'config'),
            XDG_DATA_HOME: dataHome,
            XDG_CACHE_HOME: path.join(home, 'cache'),
            XDG_STATE_HOME: path.join(home, 'state'),
            MCPORTER_NO_FORCE_EXIT: '1',
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => (stdout += chunk));
      child.stderr.on('data', (chunk: string) => (stderr += chunk));
      child.once('error', reject);
      child.once('exit', (exitCode) => resolve({ exitCode, stdout, stderr }));
      child.stdin.end(input);
    });
  }
});

function payload(expiry: Record<string, unknown>): Record<string, unknown> {
  return { tokens: { access_token: 'fake-access-token', token_type: 'Bearer', ...expiry } };
}

function rawPayload(field: string, value: string): string {
  return `{"tokens":{"access_token":"fake-access-token","token_type":"Bearer","${field}":${value}}}`;
}
