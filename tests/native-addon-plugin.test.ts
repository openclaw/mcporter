import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { nativeAddonPlugin, readNativeAssets } from '../src/cli/generate/native-addon-plugin.js';
let root: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  delete (globalThis as Record<string, unknown>).__mcporterNativeAssets;
  if (root) fs.rmSync(root, { recursive: true, force: true });
});
it('embeds release-signed assets rather than the unsigned package originals', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcporter-signed-'));
  const bytes = Buffer.from('distinct-signed-fixture');
  for (const target of ['darwin_arm64', 'darwin_x64', 'win32_arm64', 'win32_x64']) {
    fs.mkdirSync(path.join(root, target));
    fs.writeFileSync(path.join(root, target, 'koffi.node'), bytes);
  }
  fs.writeFileSync(path.join(root, 'cache-loader.cjs'), 'module.exports={loadEmbeddedNativeAddon(){}}');
  vi.stubEnv('MCPORTER_SIGNED_NATIVE_ASSETS_DIR', root);
  expect(readNativeAssets().modules['darwin-arm64']).toBe(bytes.toString('base64'));
  const plugin = nativeAddonPlugin();
  const load = typeof plugin.load === 'function' ? plugin.load : plugin.load!.handler;
  const result = await load.call({} as never, '/virtual/darwin_arm64/koffi.node', {
    rawId: '/virtual/darwin_arm64/koffi.node',
    attributes: {},
  });
  expect(result).toContain(bytes.toString('base64'));
  expect(result).toContain(createHash('sha256').update(bytes).digest('hex'));
});
it('uses embedded generator assets without the original package files', () => {
  const assets = { modules: { 'win32-arm64': 'embedded' }, loader: 'embedded-loader' };
  (globalThis as Record<string, unknown>).__mcporterNativeAssets = assets;
  vi.stubEnv('MCPORTER_SIGNED_NATIVE_ASSETS_DIR', '/missing/package');
  expect(readNativeAssets()).toBe(assets);
});
