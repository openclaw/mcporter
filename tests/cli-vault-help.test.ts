import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

process.env.MCPORTER_DISABLE_AUTORUN = '1';
const cliModulePromise = import('../src/cli.js');

describe('mcporter vault help shortcut', () => {
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

  it('describes the clientInfo shape the validator accepts', async () => {
    const { runCli } = await cliModulePromise;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runCli(['vault', '--help']);

    const output = errorSpy.mock.calls.map(([message]) => String(message)).join('\n');
    expect(output).toContain('Usage: mcporter vault');
    expect(output).toContain('dynamic client registration response');
    for (const field of ['redirect_uris', 'grant_types', 'response_types', 'contacts']) {
      expect(output).toContain(field);
    }
    expect(output).toContain('client_id_issued_at');
    expect(output).toContain('client_secret_expires_at');
    expect(process.exitCode).toBe(0);
  });
});
