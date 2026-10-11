import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleImportCommand } from '../src/cli/config/import.js';
import * as imports from '../src/config-imports.js';

let directory: string;
let configPath: string;
let originalConfig: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-import-flags-'));
  configPath = path.join(directory, 'mcporter.json');
  const cursorPath = path.join(directory, 'cursor.json');
  originalConfig = JSON.stringify({ imports: [], mcpServers: { keep: { command: 'node' } } });
  await fs.writeFile(configPath, originalConfig);
  await fs.writeFile(cursorPath, JSON.stringify({ mcpServers: { imported: { command: 'node' } } }));
  vi.spyOn(imports, 'pathsForImport').mockReturnValue([cursorPath]);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('config import valued flags', () => {
  it.each([
    ['--copy', '--path'],
    ['--copy', '--filter'],
    ['--path', '--copy'],
    ['--filter', '--copy'],
    ['--copy', '--filter', ''],
    ['--copy', '--path', ''],
  ])('rejects missing values without modifying config: %j', async (...args) => {
    await expect(
      handleImportCommand(
        {
          loadOptions: { configPath, rootDir: directory },
          invokeAuth: async () => {},
        },
        ['cursor', ...args]
      )
    ).rejects.toThrow('requires a value');
    expect(await fs.readFile(configPath, 'utf8')).toBe(originalConfig);
  });
});
