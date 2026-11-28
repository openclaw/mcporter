import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

const require = createRequire(import.meta.resolve('koffi'));
it.each(['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64'])(
  'stages the installed Koffi addon for %s',
  async (target) => {
    const directory = target.replace('-', '_');
    const source = path.dirname(require.resolve(`@koromix/koffi-${target}/package.json`));
    const staged = fileURLToPath(new URL(`../dist/native/${directory}/koffi.node`, import.meta.url));
    expect((await fs.readFile(staged)).equals(await fs.readFile(path.join(source, directory, 'koffi.node')))).toBe(
      true
    );
  }
);
