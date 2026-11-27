import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { rolldown } from 'rolldown';
import { nativeAddonPlugin } from '../src/cli/generate/native-addon-plugin.js';
import { privateFixtureDirectory } from './helpers/private-directory.js';
const exec = promisify(execFile);
it.skipIf(!['darwin', 'win32'].includes(process.platform))(
  'loads native Koffi from relocated ESM and CJS without package files',
  async () => {
    const root = await fs.realpath(await privateFixtureDirectory('mcp-native-bundle-'));
    try {
      const input = path.join(root, 'input.mjs');
      const koffi = fileURLToPath(new URL('../node_modules/koffi/index.js', import.meta.url));
      await fs.writeFile(input, `import koffi from ${JSON.stringify(koffi)}; console.log(koffi.version);`);
      const bundle = await rolldown({ input, plugins: [nativeAddonPlugin()], platform: 'node' });
      try {
        for (const format of ['cjs', 'es'] as const) {
          const file = path.join(root, `relocated.${format === 'cjs' ? 'cjs' : 'mjs'}`);
          await bundle.write({ file, format, codeSplitting: false });
          const results = await Promise.all(
            Array.from({ length: format === 'cjs' ? 10 : 1 }, () =>
              exec(process.execPath, [file], {
                env: { ...process.env, MCPORTER_DAEMON_DIR: root },
                timeout: 45000,
              })
            )
          );
          for (const result of results) expect(result.stdout.trim()).toBe('3.3.8');
        }
      } finally {
        await bundle.close();
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  60000
);
