import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleImportCommand } from '../src/cli/config/import.js';
import type { LoadConfigOptions, RawConfig } from '../src/config.js';
import * as configModule from '../src/config.js';
import * as importModule from '../src/config-imports.js';

let tempDir: string;
let loadOptions: LoadConfigOptions;
let originalXdgConfigHome: string | undefined;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-import-'));
  loadOptions = { rootDir: tempDir };
  originalXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg-config');
});

afterEach(async () => {
  if (originalXdgConfigHome === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = originalXdgConfigHome;
  }
  await fs.rm(tempDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('config import', () => {
  it('copies filtered entries into project config', async () => {
    vi.spyOn(importModule, 'pathsForImport').mockReturnValue([path.join(tempDir, 'imports', 'cursor.json')]);
    vi.spyOn(importModule, 'readExternalEntries').mockResolvedValue(
      new Map([
        ['keep', { baseUrl: 'https://example.com/mcp' }],
        ['skip', { baseUrl: 'https://skip.example/mcp' }],
      ]) as never
    );

    let writtenConfig: RawConfig | undefined;
    vi.spyOn(configModule, 'writeRawConfig').mockImplementation(async (_path, config) => {
      writtenConfig = config as RawConfig;
    });

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleImportCommand({ loadOptions } as never, ['cursor', '--copy', '--filter', 'keep']);
    logSpy.mockRestore();

    expect(writtenConfig?.mcpServers?.keep).toBeDefined();
    expect(writtenConfig?.mcpServers?.skip).toBeUndefined();
  });

  it('copies into the locked config path if another default appears while waiting', async () => {
    const xdgConfigHome = path.join(tempDir, 'xdg-config');
    vi.spyOn(importModule, 'pathsForImport').mockReturnValue([path.join(tempDir, 'imports', 'cursor.json')]);
    vi.spyOn(importModule, 'readExternalEntries').mockResolvedValue(
      new Map([['keep', { baseUrl: 'https://example.com/mcp' }]]) as never
    );

    const projectConfigPath = path.join(tempDir, 'config', 'mcporter.json');
    const homeConfigPath = path.join(xdgConfigHome, 'mcporter', 'mcporter.json');
    const lockPath = `${projectConfigPath}.lock`;
    await fs.mkdir(path.dirname(projectConfigPath), { recursive: true });
    await fs.writeFile(lockPath, `${process.pid}\n2026-01-01T00:00:00.000Z\n`, 'utf8');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      const command = handleImportCommand({ loadOptions } as never, ['cursor', '--copy']);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await fs.mkdir(path.dirname(homeConfigPath), { recursive: true });
      await fs.writeFile(
        homeConfigPath,
        JSON.stringify({ mcpServers: { home: { baseUrl: 'https://home.example/mcp' } } }),
        'utf8'
      );
      await fs.unlink(lockPath);
      await command;
    } finally {
      logSpy.mockRestore();
      await fs.unlink(lockPath).catch(() => {});
    }

    const projectConfig = JSON.parse(await fs.readFile(projectConfigPath, 'utf8')) as RawConfig;
    const homeConfig = JSON.parse(await fs.readFile(homeConfigPath, 'utf8')) as RawConfig;
    expect(projectConfig.mcpServers?.keep).toBeDefined();
    expect(homeConfig.mcpServers?.keep).toBeUndefined();
  });

  it('emits JSON when --json is provided', async () => {
    vi.spyOn(importModule, 'pathsForImport').mockReturnValue([path.join(tempDir, 'imports', 'cursor.json')]);
    vi.spyOn(importModule, 'readExternalEntries').mockResolvedValue(
      new Map([['keep', { baseUrl: 'https://example.com/mcp' }]]) as never
    );
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleImportCommand({ loadOptions } as never, ['cursor', '--json']);

    const json = logSpy.mock.calls
      .map((call) => call[0])
      .find((msg) => typeof msg === 'string' && msg.trim().startsWith('{'));
    logSpy.mockRestore();
    expect(json).toBeDefined();
    const payload = JSON.parse(String(json)) as { entries: Array<{ name: string }> };
    expect(payload.entries).toHaveLength(1);
    expect(payload.entries[0]?.name).toBe('keep');
  });
});
