import { describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { cliModulePromise } from './fixtures/cli-list-fixtures.js';

describe('CLI list flag parsing', () => {
  it('parses --timeout flag into list flags', async () => {
    const { extractListFlags } = await cliModulePromise;
    const args = ['--timeout', '7500', '--schema', 'server'];
    const flags = extractListFlags(args);
    expect(flags).toEqual({
      brief: false,
      schema: true,
      timeoutMs: 7500,
      requiredOnly: true,
      includeSources: false,
      verbose: false,
      ephemeral: undefined,
      format: 'text',
      quiet: false,
      exitCode: false,
      statusOnly: false,
      disableOAuth: false,
    });
    expect(args).toEqual(['server']);
  });

  it('parses --all-parameters flag and removes it from args', async () => {
    const { extractListFlags } = await cliModulePromise;
    const args = ['--all-parameters', 'server'];
    const flags = extractListFlags(args);
    expect(flags).toEqual({
      brief: false,
      schema: false,
      timeoutMs: undefined,
      requiredOnly: false,
      includeSources: false,
      verbose: false,
      ephemeral: undefined,
      format: 'text',
      quiet: false,
      exitCode: false,
      statusOnly: false,
      disableOAuth: false,
    });
    expect(args).toEqual(['server']);
  });

  it('parses --no-oauth and removes it from args', async () => {
    const { extractListFlags } = await cliModulePromise;
    const args = ['--no-oauth', 'server'];
    const flags = extractListFlags(args);
    expect(flags.disableOAuth).toBe(true);
    expect(args).toEqual(['server']);
  });

  it('parses --json flag and removes it from args', async () => {
    const { extractListFlags } = await cliModulePromise;
    const args = ['--json', 'server'];
    const flags = extractListFlags(args);
    expect(flags.format).toBe('json');
    expect(flags.brief).toBe(false);
    expect(args).toEqual(['server']);
  });

  it('parses status check flags', async () => {
    const { extractListFlags } = await cliModulePromise;
    const quietArgs = ['--quiet', 'server'];
    const quietFlags = extractListFlags(quietArgs);
    expect(quietFlags.quiet).toBe(true);
    expect(quietFlags.exitCode).toBe(true);
    expect(quietArgs).toEqual(['server']);

    const statusArgs = ['--status', '--exit-code', 'server'];
    const statusFlags = extractListFlags(statusArgs);
    expect(statusFlags.statusOnly).toBe(true);
    expect(statusFlags.exitCode).toBe(true);
    expect(statusArgs).toEqual(['server']);
  });

  it('rejects --status with tool-doc display flags', async () => {
    const { extractListFlags } = await cliModulePromise;
    expect(() => extractListFlags(['--status', '--brief', 'server'])).toThrow('--status cannot be used with --brief');
    expect(() => extractListFlags(['--status', '--schema', 'server'])).toThrow('--status cannot be used with --schema');
    expect(() => extractListFlags(['--status', '--all-parameters', 'server'])).toThrow(
      '--status cannot be used with --all-parameters'
    );
  });

  it('parses --brief and --signatures aliases', async () => {
    const { extractListFlags } = await cliModulePromise;
    const briefArgs = ['--brief', 'server'];
    const briefFlags = extractListFlags(briefArgs);
    expect(briefFlags.brief).toBe(true);
    expect(briefArgs).toEqual(['server']);

    const signatureArgs = ['--signatures', 'server'];
    const signatureFlags = extractListFlags(signatureArgs);
    expect(signatureFlags.brief).toBe(true);
    expect(signatureArgs).toEqual(['server']);
  });

  it('rejects --brief with incompatible display flags', async () => {
    const { extractListFlags } = await cliModulePromise;
    expect(() => extractListFlags(['--brief', '--json', 'server'])).toThrow('--brief cannot be used with --json');
    expect(() => extractListFlags(['--brief', '--schema', 'server'])).toThrow('--brief cannot be used with --schema');
    expect(() => extractListFlags(['--brief', '--verbose', 'server'])).toThrow('--brief cannot be used with --verbose');
    expect(() => extractListFlags(['--brief', '--all-parameters', 'server'])).toThrow(
      '--brief cannot be used with --all-parameters'
    );
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
    } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await handleList(runtime, ['--timeout', '10', 'slow-server']);

    const warningLines = warnSpy.mock.calls.map((call) => call[0]);
    expect(warningLines).toContain('  Tools: <timed out after 10ms>');
    expect(warningLines).toContain('  Reason: Timeout');

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
