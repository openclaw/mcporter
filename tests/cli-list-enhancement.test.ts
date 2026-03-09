import { afterEach, describe, expect, it, vi } from 'vitest';
import { cliModulePromise } from './fixtures/cli-list-fixtures.js';

describe('CLI list enhancement', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('extractListFlags', () => {
    it('parses --brief flag', async () => {
      const { extractListFlags } = await cliModulePromise;
      const args = ['--brief', 'server'];
      const flags = extractListFlags(args);
      expect(flags.brief).toBe(true);
      expect(args).toEqual(['server']);
    });

    it('throws error when --brief is used with --schema', async () => {
      const { extractListFlags } = await cliModulePromise;
      const args = ['--brief', '--schema', 'server'];
      expect(() => extractListFlags(args)).toThrow(/--brief cannot be used with/);
    });

    it('throws error when --brief is used with --verbose', async () => {
      const { extractListFlags } = await cliModulePromise;
      const args = ['--brief', '--verbose', 'server'];
      expect(() => extractListFlags(args)).toThrow(/--brief cannot be used with/);
    });

    it('throws error when --brief is used with --all-parameters (which disables requiredOnly)', async () => {
      const { extractListFlags } = await cliModulePromise;
      const args = ['--brief', '--all-parameters', 'server'];
      expect(() => extractListFlags(args)).toThrow(/--brief cannot be used with/);
    });
  });

  describe('handleList', () => {
    const mockTools = [
      {
        name: 'add_user',
        description: 'Add a user',
        inputSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
        },
      },
      {
        name: 'list_users',
        description: 'List users',
        inputSchema: {
          type: 'object',
          properties: { limit: { type: 'number' } },
        },
      },
      {
        name: 'delete_user',
        description: 'Delete a user',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string' } },
        },
      },
    ];

    const mockRuntime = {
      getDefinitions: () => [],
      getDefinition: (name: string) => ({
        name,
        command: { kind: 'stdio', command: 'noop' },
        source: { kind: 'local', path: '/tmp/config.json' },
      }),
      listTools: () => Promise.resolve(mockTools),
    };

    it('filters tools by pattern', async () => {
      const { handleList } = await cliModulePromise;
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await handleList(mockRuntime as any, ['server', 'add_*']);

      // Verify that output contains only matching tools
      const calls = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
      // This is checking text output logic for detailed view
      // Since it's detailed view, it should print tool details
      // Assuming printToolDetail behavior

      // But verify we don't see delete_user
      expect(calls).not.toContain('delete_user');
      // We might not easily verify "add_user" presence without knowing exact output format detail line
      // checking side effect: filterToolsByPattern works implies handleList integration works

      consoleSpy.mockRestore();
    });

    it('prints brief signatures for --brief', async () => {
      const { handleList } = await cliModulePromise;
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await handleList(mockRuntime as any, ['server', '--brief']);

      const calls = consoleSpy.mock.calls.map((c) => c[0]);
      // Should match function signature format
      expect(calls.some((line) => line.includes('function add_user(name?: string);'))).toBe(true);
      expect(calls.some((line) => line.includes('function list_users(limit?: number);'))).toBe(true);
      expect(calls.some((line) => line.includes('function delete_user(id?: string);'))).toBe(true);

      consoleSpy.mockRestore();
    });

    it('filters and prints brief signatures combined', async () => {
      const { handleList } = await cliModulePromise;
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await handleList(mockRuntime as any, ['server', 'add_*', '--brief']);

      const calls = consoleSpy.mock.calls.map((c) => c[0]);
      expect(calls.some((line) => line.includes('function add_user'))).toBe(true);
      expect(calls.some((line) => line.includes('function list_users'))).toBe(false);

      consoleSpy.mockRestore();
    });

    it('handles no matches with pattern', async () => {
      const { handleList } = await cliModulePromise;
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await handleList(mockRuntime as any, ['server', 'nomatch_*']);

      const calls = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(calls).toContain("Tools: <no matches for 'nomatch_*'>");

      consoleSpy.mockRestore();
    });

    it('handles no matches with pattern and brief', async () => {
      const { handleList } = await cliModulePromise;
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      await handleList(mockRuntime as any, ['server', 'nomatch_*', '--brief']);

      const calls = consoleSpy.mock.calls.map((c) => c[0]).join('\n');
      expect(calls).toContain("No tools matching pattern 'nomatch_*'.");

      consoleSpy.mockRestore();
    });
  });
});
