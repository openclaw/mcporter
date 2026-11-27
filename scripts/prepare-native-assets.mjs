// Fetch pinned upstream prebuilds at build time; installed CLIs never download or compile native code.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const builds = {
  'win32-x64': 'Ef9XpIn/AfnZWMI1lvA6IOjCsTVRlako+BXosp4cRaLZZXkgjwiBVqYXXhqZix1G8e+27UAv97XBTmDEyfS7jA==',
  'win32-arm64': 'f43sCr9lxFIvkOEE0Br+Qr5+KH2XqRm/EAQgAflYprIsjCz4eBTPVwEjbuymyN/6iDEKyO7EDz/7xQgNiyvIyA==',
  'darwin-x64': 'Pw1EsCT9Yov4Szo4joLhABbQfqNgYhwfkhWZiIbEZ2b3sGyv9Yj2N0p00jOpdTfQ+u9QFFi8XhNivJbBTqMTPA==',
  'darwin-arm64': '7tzlnYSePCQW66iEIi+wgN9HgTiF431KL9wIDhH9b+32KOYZXBdA+JyDgRVi2E5AIyJ1hdkQFNg7YCAOft2mKw==',
};
for (const [target, integrity] of Object.entries(builds)) {
  const [platform, arch] = target.split('-');
  const output = path.join(root, 'dist', 'native', `${platform}_${arch}`, 'koffi.node');
  const archive = path.join(root, 'tmp', `koffi-${target}-3.3.8.tgz`);
  let bytes = await fs.readFile(archive).catch(() => undefined);
  if (!bytes || createHash('sha512').update(bytes).digest('base64') !== integrity) {
    const response = await fetch(`https://registry.npmjs.org/@koromix/koffi-${target}/-/koffi-${target}-3.3.8.tgz`, {
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`Cannot fetch pinned Koffi ${arch} prebuild: ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha512').update(bytes).digest('base64') !== integrity)
      throw new Error('Koffi prebuild integrity mismatch.');
    await fs.mkdir(path.dirname(archive), { recursive: true });
    await fs.writeFile(archive, bytes);
  }
  const tar = gunzipSync(bytes);
  let binary;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    const name = header.subarray(0, 100).toString().replace(/\0.*$/s, '');
    const size = parseInt(header.subarray(124, 136).toString().replace(/\0.*$/s, ''), 8) || 0;
    if (name === `package/${platform}_${arch}/koffi.node`) binary = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  if (!binary || binary.length < 1000) throw new Error('Pinned Koffi prebuild is missing its addon.');
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, binary);
}
// Bundle the cache loader once so a standalone generator can pass it to another build without filesystem imports.
const { rolldown } = await import('rolldown');
const cache = await rolldown({ input: path.join(root, 'src', 'native-addon-cache.ts'), platform: 'node' });
await cache.write({ file: path.join(root, 'dist', 'native', 'cache-loader.cjs'), format: 'cjs', codeSplitting: false });
await cache.close();
