import { describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { cliModulePromise } from './fixtures/cli-list-fixtures.js';

describe('CLI list flag parsing', () => {
  it('parses --timeout flag into list flags', async () => {
    const { extractListFlags } = await cliModulePromise;
    const args = ['--timeout', '7500', '--schema', 'server'];
    const flags = extractListFlags(args);
    expect(flags).toEqual({
      schema: true,
      timeoutMs: 7500,
      requiredOnly: true,
      includeSources: false,
      verbose: false,
      brief: false,
      ephemeral: undefined,
      format: 'text',
    });
    expect(args).toEqual(['server']);
  });

  it('parses --all-parameters flag and removes it from args', async () => {
    const { extractListFlags } = await cliModulePromise;
    const args = ['--all-parameters', 'server'];
    const flags = extractListFlags(args);
    expect(flags).toEqual({
      schema: false,
      timeoutMs: undefined,
      requiredOnly: false,
      includeSources: false,
      verbose: false,
      brief: false,
      ephemeral: undefined,
      format: 'text',
    });
    expect(args).toEqual(['server']);
  });

  it('parses --json flag and removes it from args', async () => {
    const { extractListFlags } = await cliModulePromise;
    const args = ['--json', 'server'];
    const flags = extractListFlags(args);
    expect(flags.format).toBe('json');
    expect(args).toEqual(['server']);
  });

  it('treats --sse as a hidden alias for --http-url in ad-hoc mode', async () => {
    const { extractListFlags } = await cliModulePromise;
    const args = ['--sse', 'https://mcp.example.com/sse', 'list'];
    const flags = extractListFlags(args);
    expect(flags.ephemeral).toEqual({ httpUrl: 'https://mcp.example.com/sse' });
    expect(args).toEqual(['list']);
  });

  it('honors --timeout when listing a single server', async () => {
    const { handleList } = await cliModulePromise;
    const definition: ServerDefinition = {
      name: 'slow-server',
      command: { kind: 'stdio', command: 'noop', args: [], cwd: process.cwd() },
      source: { kind: 'local', path: '/tmp/config.json' },
    };

    const runtime = {
      getDefinitions: () => [definition],
      getDefinition: () => definition,
      listTools: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve([{ name: 'ok' }]), 50);
        }),
    } as unknown as Awaited<ReturnType<typeof import('../src/runtime.js')['createRuntime']>>;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => { });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });

    await handleList(runtime, ['--timeout', '10', 'slow-server']);

    const warningLines = warnSpy.mock.calls.map((call) => call[0]);
    expect(warningLines).toContain('  Tools: <timed out after 10ms>');
    expect(warningLines).toContain('  Reason: Timeout');

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
