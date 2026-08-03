import { afterEach, expect, it, vi } from 'vitest';

const originalArgv = [...process.argv];
const originalDisableAutorun = process.env.MCPORTER_DISABLE_AUTORUN;

afterEach(() => {
  process.argv = [...originalArgv];
  if (originalDisableAutorun === undefined) {
    delete process.env.MCPORTER_DISABLE_AUTORUN;
  } else {
    process.env.MCPORTER_DISABLE_AUTORUN = originalDisableAutorun;
  }
  vi.restoreAllMocks();
});

it('installs stdio guards and runs the CLI when imported as the entrypoint', async () => {
  delete process.env.MCPORTER_DISABLE_AUTORUN;
  process.argv = [process.execPath, 'mcporter', '--version'];
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

  const { __cliInternals } = await import('../src/cli.js');
  await vi.waitFor(() => expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/^\d+\.\d+\.\d+/)));

  expect(process.stdout.listeners('error')).toContain(__cliInternals.handleStdioError);
  expect(process.stderr.listeners('error')).toContain(__cliInternals.handleStdioError);
  process.stdout.removeListener('error', __cliInternals.handleStdioError);
  process.stderr.removeListener('error', __cliInternals.handleStdioError);
});
