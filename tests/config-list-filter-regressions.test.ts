import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleListCommand } from '../src/cli/config/list.js';
import * as imports from '../src/config-imports.js';

let directory: string;
let configPath: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-config-filter-'));
  configPath = path.join(directory, 'mcporter.json');
  const cursorPath = path.join(directory, 'cursor.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({
      imports: ['cursor'],
      mcpServers: Object.fromEntries(
        ['local-one', 'local-two', 'local.one'].map((name) => [name, { command: 'node' }])
      ),
    })
  );
  await fs.writeFile(cursorPath, JSON.stringify({ mcpServers: { 'import-one': { command: 'node' } } }));
  vi.spyOn(imports, 'pathsForImport').mockImplementation((kind) => (kind === 'cursor' ? [cursorPath] : []));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('documented config list filters', () => {
  it.each([
    [['local-*'], ['local-one', 'local-two']],
    [['local-?ne'], ['local-one']],
    [['local.*'], ['local.one']],
    [['--source', 'import', 'source:cursor'], ['import-one']],
    [['local.one'], ['local.one']],
    [['one'], ['local-one', 'local.one']],
    [['source:undefined'], []],
  ])('filters actual loaded definitions with %j', async (args, expected) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleListCommand(
      {
        loadOptions: { configPath, rootDir: directory },
        invokeAuth: async () => {},
      },
      ['--json', ...args]
    );
    const result = JSON.parse(String(log.mock.calls[0]?.[0])) as { servers: Array<{ name: string }> };
    expect(result.servers.map((server) => server.name).toSorted()).toEqual(expected.toSorted());
  });
});
