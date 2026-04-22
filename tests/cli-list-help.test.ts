import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.MCPORTER_DISABLE_AUTORUN = '1';
const cliModulePromise = import('../src/cli.js');

describe('mcporter list help shortcut', () => {
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

  it('prints list-specific help when --help is used', async () => {
    const { runCli } = await cliModulePromise;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runCli(['list', '--help']);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: mcporter list'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--brief'));
    expect(process.exitCode).toBe(0);
  });

  it('prints list-specific help when the bare help token follows the command', async () => {
    const { runCli } = await cliModulePromise;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runCli(['list', 'help']);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: mcporter list'));
    expect(process.exitCode).toBe(0);
  });
});
