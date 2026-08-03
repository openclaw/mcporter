import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAddCommand, resolveWriteTarget } from '../src/cli/config/add.js';
import type { LoadConfigOptions } from '../src/config.js';

describe('config add validation and persistence', () => {
  let tempDir: string;
  let loadOptions: LoadConfigOptions;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-add-validation-'));
    loadOptions = { rootDir: tempDir };
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('rejects incomplete and contradictory transport definitions', async () => {
    const run = (args: string[]) => handleAddCommand({ loadOptions } as never, args);

    await expect(run([])).rejects.toThrow('Usage: mcporter config add <name> [target]');
    await expect(run(['empty'])).rejects.toThrow('require either a --url/target or a stdio command');
    await expect(run(['args-only', '--arg', 'server.js'])).rejects.toThrow('--arg/--args requires a stdio command');
    await expect(run(['http-as-stdio', 'https://example.com/mcp', '--transport', 'stdio'])).rejects.toThrow(
      "Transport 'stdio' requires a stdio command"
    );
    await expect(run(['stdio-as-http', 'node', '--transport', 'http'])).rejects.toThrow(
      "Transport 'http' requires a URL target"
    );
    await expect(run(['bad-transport', 'node', '--transport', 'pipe'])).rejects.toThrow(
      "--transport must be one of 'http', 'sse', or 'stdio'"
    );
  });

  it('rejects malformed flag values before touching the config file', async () => {
    const run = (args: string[]) => handleAddCommand({ loadOptions } as never, args);

    await expect(run(['bad-scope', 'node', '--scope', 'workspace'])).rejects.toThrow(
      '--scope must be either "home" or "project"'
    );
    await expect(run(['bad-env', 'node', '--env', 'TOKEN'])).rejects.toThrow('--env requires KEY=value');
    await expect(run(['bad-header', 'https://example.com', '--header', '=secret'])).rejects.toThrow(
      '--header requires KEY=value'
    );
    await expect(run(['missing-value', 'node', '--description'])).rejects.toThrow(
      "Flag '--description' requires a value"
    );
    await expect(run(['bad-copy', '--copy-from', 'cursor', '--dry-run'])).rejects.toThrow(
      "--copy-from requires the format '<import>:<name>'"
    );

    await expect(fs.access(path.join(tempDir, 'config', 'mcporter.json'))).rejects.toThrow();
  });

  it('persists stdio arguments after -- and preserves values beginning with dashes', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleAddCommand({ loadOptions } as never, [
      'worker',
      '--stdio',
      'node',
      '--token-cache-dir',
      '.cache/tokens',
      '--',
      'server.js',
      '--port=3000',
    ]);

    const parsed = JSON.parse(await fs.readFile(path.join(tempDir, 'config', 'mcporter.json'), 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[]; tokenCacheDir: string }>;
    };
    expect(parsed.mcpServers.worker).toEqual({
      command: 'node',
      args: ['server.js', '--port=3000'],
      tokenCacheDir: '.cache/tokens',
    });
  });

  it('resolves explicit, project, and configured write targets with their documented precedence', () => {
    const explicit = resolveWriteTarget(
      { args: [], env: {}, headers: {}, persistPath: path.join(tempDir, 'explicit.json'), scope: 'home' },
      { configPath: path.join(tempDir, 'configured.json') },
      tempDir
    );
    expect(explicit).toBe(path.join(tempDir, 'explicit.json'));

    expect(resolveWriteTarget({ args: [], env: {}, headers: {}, scope: 'project' }, {}, tempDir)).toBe(
      path.join(tempDir, 'config', 'mcporter.json')
    );
    expect(
      resolveWriteTarget(
        { args: [], env: {}, headers: {} },
        { configPath: path.join(tempDir, 'configured.json') },
        tempDir
      )
    ).toBe(path.join(tempDir, 'configured.json'));
  });
});
