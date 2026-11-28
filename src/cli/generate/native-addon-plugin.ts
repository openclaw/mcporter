import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'rolldown';
import type { BunPlugin } from 'bun';
const packageRoot = fileURLToPath(new URL('../../../', import.meta.url));
function resolveNative(specifier: string): string | undefined {
  const match = /^@koromix\/koffi-(win32|darwin)-(x64|arm64)$/.exec(specifier);
  return match ? path.join(packageRoot, 'dist', 'native', `${match[1]}_${match[2]}`, 'koffi.node') : undefined;
}
interface NativeAssets {
  modules: Record<string, string>;
  loader: string;
}
const embedded = () =>
  (globalThis as typeof globalThis & { __mcporterNativeAssets?: NativeAssets }).__mcporterNativeAssets;
export function readNativeAssets(): NativeAssets {
  const assetRoot = process.env.MCPORTER_SIGNED_NATIVE_ASSETS_DIR ?? path.join(packageRoot, 'dist', 'native');
  return (
    embedded() ?? {
      modules: Object.fromEntries(
        ['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64'].map((target) => [
          target,
          fs.readFileSync(path.join(assetRoot, target.replace('-', '_'), 'koffi.node')).toString('base64'),
        ])
      ),
      loader: fs.readFileSync(path.join(assetRoot, 'cache-loader.cjs'), 'utf8'),
    }
  );
}
function nativeModule(file: string): string {
  const match = /(win32|darwin)_(x64|arm64)[/\\]/.exec(file);
  const arch = match ? `${match[1]}-${match[2]}` : undefined;
  const assets = readNativeAssets();
  const base64 = arch ? assets.modules[arch]! : fs.readFileSync(file).toString('base64');
  const digest = createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');
  return `const loadEmbeddedNativeAddon=(()=>{const module={exports:{}};const exports=module.exports;${assets.loader};return module.exports.loadEmbeddedNativeAddon;})();module.exports=loadEmbeddedNativeAddon(${JSON.stringify(base64)},${JSON.stringify(digest)});`;
}
// Koffi's ESM loader uses createRequire; expose its pinned platform branches to both bundlers.
const koffiStaticLoader = /[/\\]koffi[/\\]src[/\\]koffi[/\\]src[/\\]static\.(?:cjs|js)$/;
function staticLoader(): string {
  return `module.exports={loadStatic(platform){switch(platform){${['win32-x64', 'win32-arm64', 'darwin-x64', 'darwin-arm64'].map((target) => `case ${JSON.stringify(target)}:return require(${JSON.stringify('@koromix/koffi-' + target)});`).join('')}default:return null;}}};`;
}
export function nativeAddonPlugin(): Plugin {
  return {
    name: 'mcporter-native-addons',
    resolveId(specifier) {
      return resolveNative(specifier) ?? null;
    },
    load(id) {
      return koffiStaticLoader.test(id) ? staticLoader() : id.endsWith('.node') ? nativeModule(id) : null;
    },
  };
}
export function bunNativeAddonPlugin(): BunPlugin {
  return {
    name: 'mcporter-native-addons',
    setup(build) {
      build.onResolve({ filter: /^@koromix\/koffi-(win32|darwin)-(x64|arm64)$/ }, (args) => ({
        path: resolveNative(args.path)!,
      }));
      build.onLoad({ filter: koffiStaticLoader }, () => ({ contents: staticLoader(), loader: 'js' }));
      build.onLoad({ filter: /\.node$/ }, (args) => ({ contents: nativeModule(args.path), loader: 'js' }));
    },
  };
}
