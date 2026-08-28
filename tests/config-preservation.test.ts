import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleConfigCli } from '../src/cli/config-command.js';
import type { RawConfig } from '../src/config.js';
import { RawConfigSchema } from '../src/config-schema.js';
import { createTempConfig } from './fixtures/config-fixture.js';

const siblings: RawConfig['mcpServers'] = {
  siblingOne: {
    command: 'inert-sibling',
    args: ['one', 'two'],
    env: { LABEL: 'unchanged' },
    allowedTools: ['first', 'second'],
  },
  siblingTwo: {
    base_url: 'https://sibling.invalid/mcp',
    headers: { 'X-Fixture': 'unchanged' },
    description: 'Untouched sibling',
    protocol_version: 'auto',
  },
};
const originalServers: RawConfig['mcpServers'] = {
  ...siblings,
  target: {
    command: 'inert-old-target',
    args: ['stale-argument'],
    env: { OLD: 'stale' },
    headers: { 'X-Old': 'stale' },
    description: 'Stale target description',
  },
};
const addedEntry = { baseUrl: 'https://added.invalid/mcp' };
const copiedServers = {
  target: { baseUrl: 'https://imported.invalid/mcp' },
  'import-new': { command: 'inert-import', args: ['new'] },
};
const orderedImports: RawConfig['imports'] = ['vscode', 'cursor', 'codex'];
const rootCases: Array<{ name: string; settings: Omit<RawConfig, 'mcpServers'> }> = [
  { name: 'canonical timeout', settings: { daemonIdleTimeoutMs: 12345, imports: orderedImports } },
  { name: 'snake timeout', settings: { daemon_idle_timeout_ms: 67890, imports: orderedImports } },
  {
    name: 'both timeout spellings with distinct values',
    settings: { daemonIdleTimeoutMs: 12345, daemon_idle_timeout_ms: 67890, imports: orderedImports },
  },
  { name: 'ordered imports without timeouts', settings: { imports: orderedImports } },
  { name: 'empty imports without timeouts', settings: { imports: [] } },
  { name: 'omitted imports and timeouts', settings: {} },
];
const mutations: Array<{ name: string; args: string[]; expectedServers: RawConfig['mcpServers'] }> = [
  {
    name: 'add new',
    args: ['add', 'added', addedEntry.baseUrl],
    expectedServers: { ...originalServers, added: addedEntry },
  },
  {
    name: 'add replacement',
    args: ['add', 'target', addedEntry.baseUrl],
    expectedServers: { ...siblings, target: addedEntry },
  },
  { name: 'remove', args: ['remove', 'target'], expectedServers: siblings },
  {
    name: 'import --copy collision and new entry',
    args: ['import', 'cursor', '--copy'],
    expectedServers: { ...siblings, ...copiedServers },
  },
];

describe('config mutation preservation', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe.each(rootCases)('$name', ({ settings }) => {
    it.each(mutations)(
      '$name preserves the complete config outside the selected entries',
      async ({ args, expectedServers }) => {
        const ctx = await createTempConfig({ ...settings, mcpServers: originalServers });
        try {
          const commandArgs = [...args];
          if (commandArgs[0] === 'import') {
            const importPath = path.join(ctx.tempDir, 'cursor.json');
            await fs.writeFile(importPath, JSON.stringify({ mcpServers: copiedServers }), 'utf8');
            commandArgs.push('--path', importPath);
          }

          await handleConfigCli({ loadOptions: ctx.loadOptions, invokeAuth: vi.fn() }, commandArgs);

          const written = JSON.parse(await fs.readFile(ctx.configPath, 'utf8'));
          expect(written).toStrictEqual({ ...settings, mcpServers: expectedServers });
        } finally {
          await ctx.cleanup();
        }
      }
    );
  });

  it.each(['added', 'target'])('add --dry-run leaves the config bytes unchanged for %s', async (name) => {
    const ctx = await createTempConfig({
      mcpServers: originalServers,
      imports: orderedImports,
      daemonIdleTimeoutMs: 12345,
      daemon_idle_timeout_ms: 67890,
    });
    try {
      const before = await fs.readFile(ctx.configPath, 'utf8');

      await handleConfigCli({ loadOptions: ctx.loadOptions, invokeAuth: vi.fn() }, [
        'add',
        name,
        addedEntry.baseUrl,
        '--dry-run',
      ]);

      expect(await fs.readFile(ctx.configPath, 'utf8')).toBe(before);
    } finally {
      await ctx.cleanup();
    }
  });
});

it.each(['daemonIdleTimeoutMs', 'daemon_idle_timeout_ms'])('still rejects zero for %s', (key) => {
  expect(RawConfigSchema.safeParse({ mcpServers: {}, [key]: 0 }).success).toBe(false);
});
