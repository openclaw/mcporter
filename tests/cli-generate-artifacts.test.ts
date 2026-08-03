import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { bundleOutput, computeCompileTarget, resolveBundleTarget } from '../src/cli/generate/artifacts.js';

const TMP_PREFIX = path.join(os.tmpdir(), 'mcporter-artifacts-test-');

describe('bundleOutput', () => {
  it('resolves mcporter dependencies even without local node_modules', async () => {
    const tempDir = await fsPromises.mkdtemp(TMP_PREFIX);
    const entryPath = path.join(tempDir, 'entry.ts');
    const content = `import { Command } from 'commander';\nimport { createRuntime } from 'mcporter';\nconsole.log(typeof Command, typeof createRuntime);\n`;
    await fsPromises.writeFile(entryPath, content, 'utf8');
    const outputPath = path.join(tempDir, 'bundle.js');

    const result = await bundleOutput({
      sourcePath: entryPath,
      targetPath: outputPath,
      runtimeKind: 'node',
      minify: false,
      bundler: 'rolldown',
    });

    const stats = await fsPromises.stat(result);
    expect(stats.isFile()).toBe(true);
    await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });
});

describe('computeCompileTarget', () => {
  it('places compiled binaries in the current working directory with unique names', () => {
    const tempDir = fs.mkdtempSync(TMP_PREFIX);
    const originalCwd = process.cwd();
    process.chdir(tempDir);
    try {
      const first = computeCompileTarget(true, path.join(tempDir, 'bundle.js'), 'Chrome DevTools CLI');
      const normalizedTemp = fs.realpathSync(tempDir);
      const normalizedFirst = fs.realpathSync(path.dirname(first));
      expect(normalizedFirst.startsWith(normalizedTemp)).toBe(true);
      fs.writeFileSync(first, '');
      const second = computeCompileTarget(true, path.join(tempDir, 'bundle.js'), 'Chrome DevTools CLI');
      expect(second).not.toBe(first);
      expect(second).toContain('chrome-devtools-cli-1');
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('honors an explicit compile target', () => {
    expect(computeCompileTarget('dist/custom-cli', '/tmp/bundle.js', 'ignored')).toBe('dist/custom-cli');
  });
});

describe('resolveBundleTarget', () => {
  it('derives compile intermediates without overwriting the requested binary', () => {
    // An explicit --bundle path is returned verbatim.
    expect(resolveBundleTarget({ bundle: 'dist/custom.js', compile: 'dist/custom', outputPath: 'source.ts' })).toBe(
      'dist/custom.js'
    );
    // A --compile target WITH an extension is rebuilt through path.join, so it
    // picks up the platform separator; one WITHOUT an extension is passed through
    // untouched and keeps whatever separator the caller wrote. The two therefore
    // differ on Windows.
    expect(resolveBundleTarget({ compile: 'dist/custom.bin', outputPath: 'source.ts' })).toBe(
      `${path.join('dist', 'custom')}.js`
    );
    expect(resolveBundleTarget({ compile: 'dist/custom', outputPath: 'source.ts' })).toBe('dist/custom.js');
    expect(resolveBundleTarget({ compile: true, outputPath: 'dist/source.ts' })).toMatch(
      /tmp[/\\]mcporter-cli-bundles[/\\]source-\d+\.bundle\.js$/
    );
  });

  it('rejects ambiguous and missing compile destinations', () => {
    expect(() => resolveBundleTarget({ bundle: true, compile: true, outputPath: 'source.ts' })).toThrow(
      '--bundle requires an explicit output path'
    );
    expect(() => resolveBundleTarget({ outputPath: 'source.ts' })).toThrow(
      '--compile requires an explicit bundle target'
    );
  });
});
