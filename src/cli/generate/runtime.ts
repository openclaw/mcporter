import { execFile } from 'node:child_process';
import path from 'node:path';
import { devNull } from 'node:os';

export function assertSupportedBunVersion(version: string): void {
  const minimum: [number, number, number] = [1, 4, 4];
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (match) {
    const major = Number(match[1]);
    const minor = Number(match[2]);
    const patch = Number(match[3]);
    const [minimumMajor, minimumMinor, minimumPatch] = minimum;
    if (
      major > minimumMajor ||
      (major === minimumMajor && minor > minimumMinor) ||
      (major === minimumMajor && minor === minimumMinor && patch >= minimumPatch)
    ) {
      return;
    }
  }
  throw new Error(
    `Bun ${minimum.join('.')} or newer is required for native builds; found ${version}. Install a current stable Bun release and rebuild.`
  );
}

export async function resolveRuntimeKind(
  runtimeOption: 'node' | 'bun' | undefined,
  compileOption: boolean | string | undefined
): Promise<'node' | 'bun'> {
  if (runtimeOption) {
    return runtimeOption;
  }
  if (compileOption) {
    await verifyBunAvailable();
    return 'bun';
  }
  const bunAvailable = await isBunAvailable();
  return bunAvailable ? 'bun' : 'node';
}

export async function verifyBunAvailable(): Promise<string> {
  const bunBin = process.env.BUN_BIN ?? 'bun';
  return new Promise<string>((resolve, reject) => {
    execFile(
      bunBin,
      [
        `--config=${devNull}`,
        '--no-env-file',
        '--print',
        'JSON.stringify({version: process.versions.bun, executable: process.execPath})',
      ],
      { cwd: process.cwd(), env: process.env, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(
            new Error('Unable to locate Bun runtime. Install current stable Bun or set BUN_BIN to its executable.')
          );
          return;
        }
        try {
          const runtime: unknown = JSON.parse(stdout);
          if (
            typeof runtime !== 'object' ||
            runtime === null ||
            !('version' in runtime) ||
            typeof runtime.version !== 'string' ||
            !('executable' in runtime) ||
            typeof runtime.executable !== 'string' ||
            !path.isAbsolute(runtime.executable)
          ) {
            throw new Error(
              'Unable to identify Bun runtime. Install current stable Bun or set BUN_BIN to its executable.'
            );
          }
          assertSupportedBunVersion(runtime.version);
          resolve(runtime.executable);
        } catch (metadataError) {
          reject(
            metadataError instanceof SyntaxError
              ? new Error(
                  'Unable to identify Bun runtime. Install current stable Bun or set BUN_BIN to its executable.',
                  { cause: metadataError }
                )
              : metadataError
          );
        }
      }
    );
  });
}

async function isBunAvailable(): Promise<boolean> {
  try {
    await verifyBunAvailable();
    return true;
  } catch {
    return false;
  }
}
