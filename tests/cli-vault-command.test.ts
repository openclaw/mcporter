import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleVaultCommand, __vaultCommandInternals } from '../src/cli/vault-command.js';
import { loadServerDefinitions } from '../src/config.js';
import { buildOAuthPersistence } from '../src/oauth-persistence.js';
import { loadVaultEntry } from '../src/oauth-vault.js';

describe('mcporter vault CLI', () => {
  const originalEnv = { ...process.env };
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-vault-'));
    configPath = path.join(tempDir, 'config', 'mcporter.json');
    process.env = { ...originalEnv, XDG_DATA_HOME: path.join(tempDir, 'data') };
    vi.spyOn(os, 'homedir').mockReturnValue(path.join(tempDir, 'home'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    process.env = { ...originalEnv };
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('seeds tokens and clientInfo from a JSON file through OAuth persistence', async () => {
    await writeConfig({
      linear: { baseUrl: 'https://mcp.linear.app/mcp', auth: 'oauth' },
    });
    const payloadPath = path.join(tempDir, 'linear-oauth.json');
    await fs.writeFile(
      payloadPath,
      JSON.stringify({
        tokens: { access_token: 'file-token', refresh_token: 'refresh-token', token_type: 'Bearer' },
        clientInfo: { client_id: 'client-123' },
      }),
      'utf8'
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleVaultCommand({ loadOptions: { configPath } }, ['set', 'linear', '--tokens-file', payloadPath]);

    const [definition] = await loadServerDefinitions({ configPath });
    expect(definition).toBeDefined();
    const persistence = await buildOAuthPersistence(definition!);
    expect(await persistence.readTokens()).toEqual({
      access_token: 'file-token',
      refresh_token: 'refresh-token',
      token_type: 'Bearer',
    });
    expect(await persistence.readClientInfo()).toEqual({ client_id: 'client-123' });
    expect(logSpy).toHaveBeenCalledWith("Seeded OAuth credentials for 'linear'.");
    expect(logSpy.mock.calls.flat().join('\n')).not.toContain('file-token');
  });

  it('seeds tokens from stdin and honors explicit tokenCacheDir stores', async () => {
    const tokenCacheDir = path.join(tempDir, 'token-cache');
    await writeConfig({
      linear: {
        baseUrl: 'https://mcp.linear.app/mcp',
        tokenCacheDir,
      },
    });
    vi.spyOn(fsSync, 'readFileSync').mockReturnValueOnce(
      JSON.stringify({ tokens: { access_token: 'stdin-token', token_type: 'Bearer' } })
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleVaultCommand({ loadOptions: { configPath } }, ['set', 'linear', '--stdin']);

    const [definition] = await loadServerDefinitions({ configPath });
    const persistence = await buildOAuthPersistence(definition!);
    expect(await persistence.readTokens()).toEqual({ access_token: 'stdin-token', token_type: 'Bearer' });
    const cacheTokens = JSON.parse(await fs.readFile(path.join(tokenCacheDir, 'tokens.json'), 'utf8')) as {
      access_token?: string;
    };
    expect(cacheTokens.access_token).toBe('stdin-token');
  });

  it('clears credentials using the same broad cache semantics as config logout', async () => {
    const tokenCacheDir = path.join(tempDir, 'token-cache');
    await writeConfig({
      linear: {
        baseUrl: 'https://mcp.linear.app/mcp',
        auth: 'oauth',
        tokenCacheDir,
      },
    });
    const payloadPath = path.join(tempDir, 'linear-oauth.json');
    await fs.writeFile(
      payloadPath,
      JSON.stringify({ tokens: { access_token: 'clear-token', token_type: 'Bearer' } }),
      'utf8'
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleVaultCommand({ loadOptions: { configPath } }, ['set', 'linear', '--tokens-file', payloadPath]);
    const [definition] = await loadServerDefinitions({ configPath });
    expect(await loadVaultEntry(definition!)).toBeDefined();
    await handleVaultCommand({ loadOptions: { configPath } }, ['clear', 'linear']);

    await expect(fs.access(tokenCacheDir)).rejects.toThrow();
    expect(await loadVaultEntry(definition!)).toBeUndefined();
  });

  it('uses rootDir config resolution when no explicit config path is supplied', async () => {
    await writeConfig({
      project: { baseUrl: 'https://project.example/mcp' },
    });
    const payloadPath = path.join(tempDir, 'project-oauth.json');
    await fs.writeFile(
      payloadPath,
      JSON.stringify({ tokens: { access_token: 'root-token', token_type: 'Bearer' } }),
      'utf8'
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleVaultCommand({ loadOptions: { rootDir: tempDir } }, ['set', 'project', '--tokens-file', payloadPath]);

    const [definition] = await loadServerDefinitions({ rootDir: tempDir });
    const persistence = await buildOAuthPersistence(definition!);
    expect(await persistence.readTokens()).toEqual({ access_token: 'root-token', token_type: 'Bearer' });
  });

  it('rejects malformed payloads without leaking token material', () => {
    try {
      __vaultCommandInternals.parseSeedPayload(
        JSON.stringify({
          tokens: { access_token: 'secret-token', token_type: 123 },
        })
      );
      throw new Error('Expected payload parsing to fail');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain("Invalid vault payload: 'tokens' must match mcporter OAuth token storage shape.");
      expect(message).not.toContain('secret-token');
    }
  });

  it('rejects ambiguous or missing input sources', () => {
    expect(() => __vaultCommandInternals.parseSetArgs(['linear'])).toThrow(
      'Usage: mcporter vault set <server> --tokens-file <path> | --stdin'
    );
    expect(() => __vaultCommandInternals.parseSetArgs(['linear', '--stdin', '--tokens-file', 'tokens.json'])).toThrow(
      "Specify exactly one of '--tokens-file <path>' or '--stdin'."
    );
  });

  async function writeConfig(mcpServers: Record<string, unknown>): Promise<void> {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ mcpServers }), 'utf8');
  }
});
