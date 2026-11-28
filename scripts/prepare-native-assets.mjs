// Stage pnpm-installed prebuilds; installed CLIs never download or compile native code.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.resolve('koffi'));
for (const target of ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64']) {
  const directory = target.replace('-', '_');
  const source = path.dirname(require.resolve(`@koromix/koffi-${target}/package.json`));
  const output = path.join(root, 'dist', 'native', directory);
  await fs.mkdir(output, { recursive: true });
  await fs.copyFile(path.join(source, directory, 'koffi.node'), path.join(output, 'koffi.node'));
}
// Bundle the cache loader once so a standalone generator can pass it to another build without filesystem imports.
const { rolldown } = await import('rolldown');
const cache = await rolldown({ input: path.join(root, 'src', 'native-addon-cache.ts'), platform: 'node' });
await cache.write({ file: path.join(root, 'dist', 'native', 'cache-loader.cjs'), format: 'cjs', codeSplitting: false });
await cache.close();
