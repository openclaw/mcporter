import fsPromises from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';

process.env.MCPORTER_DISABLE_AUTORUN = '1';
const cliModulePromise = import('../src/cli.js');

const packageJsonPath = new URL('../package.json', import.meta.url);
async function readPackageVersion(): Promise<string> {
  const buffer = await fsPromises.readFile(packageJsonPath, 'utf8');
  const pkg = JSON.parse(buffer) as { version?: string };
  return pkg.version ?? '0.0.0';
}

describe('mcporter global shortcuts', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('prints global help before inference when --help is provided', async () => {
    const { runCli } = await cliModulePromise;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runCli(['--help']);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: mcporter'));
    expect(process.exitCode).toBe(0);
  });

  it('prints global help when the bare help token is provided', async () => {
    const { runCli } = await cliModulePromise;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runCli(['help']);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: mcporter'));
    expect(process.exitCode).toBe(0);
  });

  it('aligns every global flag description in one column after a gap', async () => {
    const { runCli } = await cliModulePromise;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runCli(['--help']);

    const output = errorSpy.mock.calls.map((call) => String(call[0])).join('\n');
    const lines = output.split('\n');
    const start = lines.findIndex((line) => line.trim() === 'Global flags');
    const end = lines.findIndex((line, index) => index > start && line.trim() === '');
    const flagLines = lines.slice(start + 1, end);
    const rows = flagLines.map((line) => /^ {2}(--\S+(?: <[^>]+>)?) {2,}(\S.*)$/.exec(line));
    expect(rows.map((row) => row?.[1])).toEqual([
      '--config <path>',
      '--root <path>',
      '--log-level <debug|info|warn|error>',
      '--oauth-timeout <ms>',
    ]);
    const columns = new Set(flagLines.map((line, index) => line.indexOf(rows[index]?.[2] ?? '')));
    expect(columns.size).toBe(1);
  });

  it('prints the package version when --version is provided', async () => {
    const { runCli } = await cliModulePromise;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const expectedVersion = await readPackageVersion();

    await runCli(['--version']);

    expect(logSpy).toHaveBeenCalledWith(expectedVersion);
    expect(process.exitCode).toBeUndefined();
  });

  it('prints the package version when -v is provided', async () => {
    const { runCli } = await cliModulePromise;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const expectedVersion = await readPackageVersion();

    await runCli(['-v']);

    expect(logSpy).toHaveBeenCalledWith(expectedVersion);
    expect(process.exitCode).toBeUndefined();
  });
});
