import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.MCPORTER_DISABLE_AUTORUN = '1';
const cliModulePromise = import('../src/cli.js');

describe('mcporter help shortcuts (hidden)', () => {
  let previousNoForceExit: string | undefined;

  beforeEach(() => {
    previousNoForceExit = process.env.MCPORTER_NO_FORCE_EXIT;
    process.env.MCPORTER_NO_FORCE_EXIT = '1';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    if (previousNoForceExit === undefined) {
      delete process.env.MCPORTER_NO_FORCE_EXIT;
    } else {
      process.env.MCPORTER_NO_FORCE_EXIT = previousNoForceExit;
    }
  });

  const cases: Array<{ args: string[]; expectSnippet: string }> = [
    { args: ['call', '--help'], expectSnippet: 'Usage: mcporter call' },
    { args: ['call', 'help'], expectSnippet: 'Usage: mcporter call' },
    { args: ['auth', '--help'], expectSnippet: 'Usage: mcporter auth' },
    { args: ['auth', 'help'], expectSnippet: 'Usage: mcporter auth' },
    { args: ['heavy', '--help'], expectSnippet: 'Usage: mcporter heavy' },
    { args: ['heavy', 'help'], expectSnippet: 'Usage: mcporter heavy' },
    { args: ['list', '--help'], expectSnippet: 'Usage: mcporter list' },
    { args: ['list', 'help'], expectSnippet: 'Usage: mcporter list' },
  ];

  it.each(cases)('prints help for %j', async ({ args, expectSnippet }) => {
    const { runCli } = await cliModulePromise;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runCli(args);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(expectSnippet));
    expect(process.exitCode).toBe(0);
  });
});
