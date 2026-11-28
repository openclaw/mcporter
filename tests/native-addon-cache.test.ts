import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { loadEmbeddedNativeAddon } from '../src/native-addon-cache.js';
const bytes = Buffer.from('synthetic-native-bytes');
const hash = createHash('sha256').update(bytes).digest('hex');
let root: string;
const nativeLoad = vi.fn((module: Parameters<typeof process.dlopen>[0]) => {
  module.exports = { loaded: true };
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-addon-'));
  vi.stubEnv('MCPORTER_DAEMON_DIR', root);
  nativeLoad.mockClear();
  vi.spyOn(process, 'dlopen').mockImplementation(nativeLoad);
}
it.skipIf(process.platform === 'win32')('reuses a verified content address and rejects corrupt cached bytes', () => {
  fixture();
  expect(loadEmbeddedNativeAddon(bytes.toString('base64'), hash)).toEqual({ loaded: true });
  expect(loadEmbeddedNativeAddon(bytes.toString('base64'), hash)).toEqual({ loaded: true });
  const cache = path.join(root, 'daemon', 'native');
  expect(fs.readdirSync(cache)).toEqual([`${process.arch}-${hash}.node`]);
  fs.writeFileSync(path.join(cache, `${process.arch}-${hash}.node`), 'corrupt');
  expect(() => loadEmbeddedNativeAddon(bytes.toString('base64'), hash)).toThrow('corrupt');
  expect(nativeLoad).toHaveBeenCalledTimes(2);
});
it('rejects mismatched embedded digest before executing native code', () => {
  fixture();
  expect(() => loadEmbeddedNativeAddon(bytes.toString('base64'), '0'.repeat(64))).toThrow('Invalid embedded');
  expect(nativeLoad).not.toHaveBeenCalled();
});
it.skipIf(process.platform === 'win32')('refuses a symlink cache directory', () => {
  fixture();
  fs.mkdirSync(path.join(root, 'daemon'));
  const other = path.join(root, 'other');
  fs.mkdirSync(other);
  fs.symlinkSync(other, path.join(root, 'daemon', 'native'));
  expect(() => loadEmbeddedNativeAddon(bytes.toString('base64'), hash)).toThrow('Unsafe');
  expect(nativeLoad).not.toHaveBeenCalled();
});

it.skipIf(process.platform === 'win32')('rechecks file and directory permissions on every load', () => {
  fixture();
  loadEmbeddedNativeAddon(bytes.toString('base64'), hash);
  const cache = path.join(root, 'daemon', 'native');
  const file = path.join(cache, `${process.arch}-${hash}.node`);
  fs.chmodSync(file, 0o666);
  expect(() => loadEmbeddedNativeAddon(bytes.toString('base64'), hash)).toThrow('unsafe');
  fs.chmodSync(file, 0o600);
  fs.chmodSync(cache, 0o777);
  expect(() => loadEmbeddedNativeAddon(bytes.toString('base64'), hash)).toThrow('Unsafe');
  expect(nativeLoad).toHaveBeenCalledTimes(1);
});
