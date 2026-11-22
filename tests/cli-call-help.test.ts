import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.MCPORTER_DISABLE_AUTORUN = '1';
const cliModulePromise = import('../src/cli.js');

describe('mcporter call help shortcut', () => {
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

  it('prints call-specific help when --help is used', async () => {
    const { runCli } = await cliModulePromise;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runCli(['call', '--help']);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: mcporter call'));
    expect(process.exitCode).toBe(0);
  });

  it('prints call-specific help when the bare help token follows the command', async () => {
    const { runCli } = await cliModulePromise;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runCli(['call', 'help']);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: mcporter call'));
    expect(process.exitCode).toBe(0);
  });

  it.each([['call'], ['resource']])('aligns every %s --help row in one column after a gap', async (command) => {
    const { runCli } = await cliModulePromise;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runCli([command, '--help']);

    const output = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    const examplesAt = output.split('\n').findIndex((line) => line === 'Examples:');
    const rows = output
      .split('\n')
      .slice(0, examplesAt)
      .filter((line) => line.startsWith('  '));
    expect(rows.length).toBeGreaterThan(3);
    const columns = new Set(
      rows.map((line) => {
        const flagAndGap = /^( {2}\S(?:.*?\S)? {2,})\S/.exec(line)?.[1];
        expect(flagAndGap, line).toBeDefined();
        return flagAndGap?.length;
      })
    );
    expect(columns.size).toBe(1);
  });
});
