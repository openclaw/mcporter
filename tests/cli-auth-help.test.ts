import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.MCPORTER_DISABLE_AUTORUN = '1';
const cliModulePromise = import('../src/cli.js');

describe('mcporter auth help shortcut', () => {
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

  it('prints auth-specific help when --help is used', async () => {
    const { runCli } = await cliModulePromise;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runCli(['auth', '--help']);

    const output = errorSpy.mock.calls.map(([message]) => String(message)).join('\n');
    expect(output).toContain('Usage: mcporter auth');
    expect(output).toContain('--no-browser');
    expect(output).toContain('--browser none');
    expect(output).toContain('MCPORTER_OAUTH_NO_BROWSER');
    expect(process.exitCode).toBe(0);
  });

  it('prints auth-specific help when the bare help token follows the command', async () => {
    const { runCli } = await cliModulePromise;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runCli(['auth', 'help']);

    const output = errorSpy.mock.calls.map(([message]) => String(message)).join('\n');
    expect(output).toContain('Usage: mcporter auth');
    expect(output).toContain('--no-browser');
    expect(output).toContain('--browser none');
    expect(output).toContain('MCPORTER_OAUTH_NO_BROWSER');
    expect(process.exitCode).toBe(0);
  });
});
