import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleListCommand } from '../src/cli/config/list.js';
import * as imports from '../src/config-imports.js';
import { budget } from './helpers/timing.js';

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
    [['*'], ['local-one', 'local-two', 'local.one']],
    [['**al**o**'], ['local-one', 'local-two', 'local.one']],
    [['al-o?'], ['local-one']],
    [['*missing?'], []],
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

it('finishes a failing multi-star filter with bounded matching work', async () => {
  const name = 'a'.repeat(2000);
  await fs.writeFile(configPath, JSON.stringify({ imports: [], mcpServers: { [name]: { command: 'node' } } }));
  const script = `import { handleListCommand } from './src/cli/config/list.ts'; await handleListCommand({ loadOptions: ${JSON.stringify({ configPath, rootDir: directory })}, invokeAuth: async () => {} }, ['--json', '*a*a*a*a*a*z']);`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    cwd: process.cwd(),
    timeout: budget(10000),
    encoding: 'utf8',
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).servers).toEqual([]);
});
