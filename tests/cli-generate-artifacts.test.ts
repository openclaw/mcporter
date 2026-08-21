import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { MCPORTER_VERSION } from '../src/version.js';
import {
  artifactsTestHooks,
  bundleOutput,
  compileBundleWithBun,
  computeCompileTarget,
  resolveBundleTarget,
} from '../src/cli/generate/artifacts.js';

const TMP_PREFIX = path.join(os.tmpdir(), 'mcporter-artifacts-test-');
const FAKE_BUN_PATH = fileURLToPath(new URL('./fixtures/fake-bun.mjs', import.meta.url));
const FAKE_NPM_PATH = fileURLToPath(new URL('./fixtures/fake-npm.mjs', import.meta.url));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function readInvocationLog(logPath: string): Promise<Array<{ args: string[]; cwd: string }>> {
  const contents = await fsPromises.readFile(logPath, 'utf8');
  return contents
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { args: string[]; cwd: string });
}

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

  it('writes ESM output with the Node require banner', async () => {
    const tempDir = await fsPromises.mkdtemp(TMP_PREFIX);
    try {
      const entryPath = path.join(tempDir, 'entry.ts');
      await fsPromises.writeFile(entryPath, 'console.log("esm fixture");\n', 'utf8');

      const result = await bundleOutput({
        sourcePath: entryPath,
        targetPath: path.join(tempDir, 'bundle.mjs'),
        runtimeKind: 'node',
        minify: true,
        bundler: 'rolldown',
      });

      const contents = await fsPromises.readFile(result, 'utf8');
      expect(contents).toContain('from"node:module"');
      expect(contents).toContain('import.meta.url');
      expect(contents).toContain('esm fixture');
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === 'win32')('Bun artifact generation', () => {
  beforeAll(async () => {
    await fsPromises.chmod(FAKE_BUN_PATH, 0o755);
  });

  it.each([
    { runtimeKind: 'node' as const, minify: false },
    { runtimeKind: 'bun' as const, minify: true },
  ])('bundles for $runtimeKind with minify=$minify', async ({ runtimeKind, minify }) => {
    const tempDir = await fsPromises.mkdtemp(TMP_PREFIX);
    const logPath = path.join(tempDir, 'bun.log');
    vi.stubEnv('BUN_BIN', FAKE_BUN_PATH);
    vi.stubEnv('FAKE_BUN_LOG', logPath);
    try {
      const entryPath = path.join(tempDir, 'entry.ts');
      const targetPath = path.join(tempDir, 'nested', 'bundle.js');
      await fsPromises.writeFile(entryPath, 'console.log("bun fixture");\n', 'utf8');

      const result = await bundleOutput({
        sourcePath: entryPath,
        targetPath,
        runtimeKind,
        minify,
        bundler: 'bun',
      });

      expect(result).toBe(path.resolve(targetPath));
      expect(await fsPromises.readFile(result, 'utf8')).toContain('fake bun bundle');
      expect((await fsPromises.stat(result)).mode & 0o111).not.toBe(0);
      const invocations = await readInvocationLog(logPath);
      expect(invocations[0]?.args).toEqual(['--version']);
      const build = invocations.find((invocation) => invocation.args[0] === 'build');
      expect(build?.args).toEqual([
        'build',
        expect.stringMatching(/[/\\]bundle-[^/\\]+[/\\]entry\.ts$/),
        '--outfile',
        path.resolve(targetPath),
        '--target',
        runtimeKind,
        ...(minify ? ['--minify'] : []),
      ]);
      expect(build?.cwd).toMatch(/[/\\]bundle-[^/\\]+$/);
      await expect(fsPromises.access(build?.cwd ?? '')).rejects.toThrow();
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('removes the staging directory when Bun bundling fails', async () => {
    const tempDir = await fsPromises.mkdtemp(TMP_PREFIX);
    const logPath = path.join(tempDir, 'bun.log');
    vi.stubEnv('BUN_BIN', FAKE_BUN_PATH);
    vi.stubEnv('FAKE_BUN_LOG', logPath);
    vi.stubEnv('FAKE_BUN_FAIL', '1');
    try {
      const entryPath = path.join(tempDir, 'entry.ts');
      await fsPromises.writeFile(entryPath, 'console.log("failure fixture");\n', 'utf8');

      await expect(
        bundleOutput({
          sourcePath: entryPath,
          targetPath: path.join(tempDir, 'bundle.js'),
          runtimeKind: 'node',
          minify: false,
          bundler: 'bun',
        })
      ).rejects.toThrow('Command failed');

      const build = (await readInvocationLog(logPath)).find((invocation) => invocation.args[0] === 'build');
      expect(build).toBeDefined();
      await expect(fsPromises.access(build?.cwd ?? '')).rejects.toThrow();
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('compiles a bundle and marks the result executable', async () => {
    const tempDir = await fsPromises.mkdtemp(TMP_PREFIX);
    const logPath = path.join(tempDir, 'bun.log');
    vi.stubEnv('BUN_BIN', FAKE_BUN_PATH);
    vi.stubEnv('FAKE_BUN_LOG', logPath);
    try {
      const bundlePath = path.join(tempDir, 'bundle.js');
      const outputPath = path.join(tempDir, 'compiled-cli');
      await fsPromises.writeFile(bundlePath, 'console.log("compile fixture");\n', 'utf8');

      await compileBundleWithBun(bundlePath, outputPath);

      expect(await fsPromises.readFile(outputPath, 'utf8')).toContain('fake compiled bun artifact');
      expect((await fsPromises.stat(outputPath)).mode & 0o111).not.toBe(0);
      const build = (await readInvocationLog(logPath)).find((invocation) => invocation.args[0] === 'build');
      expect(build?.args).toEqual(['build', bundlePath, '--compile', '--outfile', outputPath]);
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('surfaces Bun compilation failures without creating an artifact', async () => {
    const tempDir = await fsPromises.mkdtemp(TMP_PREFIX);
    vi.stubEnv('BUN_BIN', FAKE_BUN_PATH);
    vi.stubEnv('FAKE_BUN_FAIL', '1');
    try {
      const bundlePath = path.join(tempDir, 'bundle.js');
      const outputPath = path.join(tempDir, 'compiled-cli');
      await fsPromises.writeFile(bundlePath, 'console.log("compile fixture");\n', 'utf8');

      await expect(compileBundleWithBun(bundlePath, outputPath)).rejects.toThrow('Command failed');
      await expect(fsPromises.access(outputPath)).rejects.toThrow();
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe('artifact implementation behavior', () => {
  it('selects output formats from explicit extensions before runtime defaults', () => {
    expect(artifactsTestHooks.outputFormatForTarget('bundle.mjs', 'node')).toBe('esm');
    expect(artifactsTestHooks.outputFormatForTarget('bundle.cjs', 'bun')).toBe('cjs');
    expect(artifactsTestHooks.outputFormatForTarget('bundle.js', 'bun')).toBe('esm');
    expect(artifactsTestHooks.outputFormatForTarget('bundle.js', 'node')).toBe('cjs');
    expect(artifactsTestHooks.buildEsmRequireBanner()).toContain('__mcporterCreateRequire(import.meta.url)');
  });

  it('recognizes only unresolved Node builtin warnings', () => {
    expect(
      artifactsTestHooks.isExpectedNodeBuiltinWarning({
        code: 'UNRESOLVED_IMPORT',
        message: 'Could not resolve "node:fs"',
      })
    ).toBe(true);
    expect(
      artifactsTestHooks.isExpectedNodeBuiltinWarning({
        code: 'UNRESOLVED_IMPORT',
        message: "Could not resolve 'left-pad'",
      })
    ).toBe(false);
    expect(artifactsTestHooks.isExpectedNodeBuiltinWarning({ code: 'OTHER', message: 'node:fs' })).toBe(false);
    expect(artifactsTestHooks.isExpectedNodeBuiltinWarning({})).toBe(false);
  });

  it('resolves local dependencies and aliases exact package specifiers', async () => {
    const commanderPath = artifactsTestHooks.resolveLocalDependency('commander');
    expect(commanderPath).toBeDefined();
    expect(artifactsTestHooks.resolveLocalDependency('definitely-not-an-installed-package')).toBeUndefined();
    const plugin = artifactsTestHooks.createLocalDependencyAliasPlugin(['commander']) as
      | { name: string; resolveId: (source: string) => string | null }
      | undefined;
    expect(plugin?.name).toBe('mcporter-local-deps');
    expect(plugin?.resolveId('commander')).toBe(commanderPath);
    expect(plugin?.resolveId('commander/subpath')).toBeNull();
    expect(artifactsTestHooks.createLocalDependencyAliasPlugin([])).toBeUndefined();
  });

  it('falls back cleanly when optional package metadata cannot be used', () => {
    const originalReadFileSync = fs.readFileSync;
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation((filePath, options) => {
      if (String(filePath).endsWith(path.join('jsonc-parser', 'package.json'))) {
        return '{}';
      }
      return originalReadFileSync(filePath, options as never);
    });
    expect(artifactsTestHooks.resolveLocalDependency('jsonc-parser')).toBeDefined();
    readSpy.mockRestore();

    const originalExistsSync = fs.existsSync;
    vi.spyOn(fs, 'existsSync').mockImplementation((filePath) => {
      if (String(filePath).includes(`${path.sep}jsonc-parser${path.sep}lib${path.sep}esm${path.sep}`)) {
        return false;
      }
      return originalExistsSync(filePath);
    });
    expect(artifactsTestHooks.resolveLocalDependency('jsonc-parser')).toBeDefined();
  });

  it('finds and stages the generated CLI dependencies', async () => {
    const tempDir = await fsPromises.mkdtemp(TMP_PREFIX);
    try {
      expect(await artifactsTestHooks.findMissingBundlerDeps(tempDir)).toEqual([
        'commander',
        'mcporter',
        'jsonc-parser',
      ]);
      await artifactsTestHooks.ensureBundlerDeps(tempDir);
      expect(await artifactsTestHooks.findMissingBundlerDeps(tempDir)).toEqual([]);
      for (const dependency of ['commander', 'mcporter', 'jsonc-parser']) {
        await expect(fsPromises.access(path.join(tempDir, 'node_modules', dependency, 'package.json'))).resolves.toBe(
          undefined
        );
      }
      expect(artifactsTestHooks.resolveDependencyDirectory('commander')).toBeDefined();
      expect(path.resolve(artifactsTestHooks.resolveDependencyDirectory('mcporter') ?? '')).toBe(path.resolve('.'));
      expect(
        artifactsTestHooks.resolveDependencyDirectory(
          'definitely-not-installed' as Parameters<typeof artifactsTestHooks.resolveDependencyDirectory>[0]
        )
      ).toBeUndefined();
      expect(
        artifactsTestHooks.resolveDependencyDirectory(
          'fs' as Parameters<typeof artifactsTestHooks.resolveDependencyDirectory>[0]
        )
      ).toBeUndefined();
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('routes unresolved staged dependencies to the offline install guard', async () => {
    const tempDir = await fsPromises.mkdtemp(TMP_PREFIX);
    const originalExistsSync = fs.existsSync;
    vi.spyOn(fs, 'existsSync').mockImplementation((filePath) => {
      if (path.basename(String(filePath)) === 'package.json') {
        return false;
      }
      return originalExistsSync(filePath);
    });
    vi.stubEnv('MCPORTER_BUNDLER_DEP_PACKAGE', '0.0.0-dev');
    try {
      await expect(artifactsTestHooks.ensureBundlerDeps(tempDir)).rejects.toThrow(
        'Unable to resolve generated-CLI bundler dependencies'
      );
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('links dependencies and tolerates existing or vanished targets', async () => {
    const tempDir = await fsPromises.mkdtemp(TMP_PREFIX);
    try {
      const sourceDir = path.join(tempDir, 'source');
      await fsPromises.mkdir(sourceDir);
      await fsPromises.writeFile(path.join(sourceDir, 'fixture.txt'), 'linked', 'utf8');
      const linkedTarget = path.join(tempDir, 'linked');
      await artifactsTestHooks.linkOrCopyDependency(sourceDir, linkedTarget);
      expect(await fsPromises.readFile(path.join(linkedTarget, 'fixture.txt'), 'utf8')).toBe('linked');

      const existingTarget = path.join(tempDir, 'existing');
      await fsPromises.mkdir(existingTarget);
      await expect(artifactsTestHooks.linkOrCopyDependency(sourceDir, existingTarget)).resolves.toBeUndefined();
      await expect(
        artifactsTestHooks.linkOrCopyDependency(sourceDir, path.join(tempDir, 'missing-parent', 'target'))
      ).resolves.toBeUndefined();
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('copies a dependency when directory symlinks are not permitted', async () => {
    const tempDir = await fsPromises.mkdtemp(TMP_PREFIX);
    try {
      const sourceDir = path.join(tempDir, 'source');
      const targetDir = path.join(tempDir, 'copied');
      await fsPromises.mkdir(sourceDir);
      await fsPromises.writeFile(path.join(sourceDir, 'fixture.txt'), 'copied', 'utf8');
      vi.spyOn(fsPromises, 'symlink').mockRejectedValueOnce(
        Object.assign(new Error('symlinks forbidden'), { code: 'EPERM' })
      );

      await artifactsTestHooks.linkOrCopyDependency(sourceDir, targetDir);

      expect(await fsPromises.readFile(path.join(targetDir, 'fixture.txt'), 'utf8')).toBe('copied');
      expect((await fsPromises.lstat(targetDir)).isSymbolicLink()).toBe(false);
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('does not hide unexpected dependency-linking errors', async () => {
    vi.spyOn(fsPromises, 'symlink').mockRejectedValueOnce(Object.assign(new Error('disk failure'), { code: 'EIO' }));
    await expect(artifactsTestHooks.linkOrCopyDependency('/source', '/target')).rejects.toThrow('disk failure');
  });

  it('sanitizes generated names and resolves collisions', async () => {
    const tempDir = await fsPromises.mkdtemp(TMP_PREFIX);
    try {
      expect(artifactsTestHooks.sanitizeFileName('  My Fancy CLI!!  ')).toBe('my-fancy-cli');
      expect(artifactsTestHooks.sanitizeFileName('!!!')).toBe('');
      expect(artifactsTestHooks.sanitizeFileName(`alpha${'-'.repeat(100_000)}beta`)).toBe('alpha-beta');
      await fsPromises.writeFile(path.join(tempDir, 'tool'), '', 'utf8');
      await fsPromises.writeFile(path.join(tempDir, 'tool-1'), '', 'utf8');
      expect(artifactsTestHooks.resolveUniquePath(tempDir, 'tool')).toBe(path.join(tempDir, 'tool-2'));
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects dependency installation for unpublished development builds', async () => {
    const tempDir = await fsPromises.mkdtemp(TMP_PREFIX);
    vi.stubEnv('MCPORTER_BUNDLER_DEP_PACKAGE', '0.0.0-dev');
    try {
      await expect(artifactsTestHooks.installPublishedBundlerDeps(tempDir)).rejects.toThrow(
        'Unable to resolve generated-CLI bundler dependencies'
      );
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform === 'win32')('published dependency installation', () => {
  async function prepareFakeNpm(tempDir: string): Promise<string> {
    const binDir = path.join(tempDir, 'bin');
    const npmPath = path.join(binDir, 'npm');
    await fsPromises.mkdir(binDir);
    await fsPromises.copyFile(FAKE_NPM_PATH, npmPath);
    await fsPromises.chmod(npmPath, 0o755);
    return binDir;
  }

  it('runs a no-script npm install for the selected published package', async () => {
    const tempDir = await fsPromises.mkdtemp(TMP_PREFIX);
    const logPath = path.join(tempDir, 'npm.log');
    const binDir = await prepareFakeNpm(tempDir);
    vi.stubEnv('PATH', `${binDir}${path.delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('FAKE_NPM_LOG', logPath);
    vi.stubEnv('MCPORTER_BUNDLER_DEP_PACKAGE', 'file:mcporter-fixture.tgz');
    try {
      await artifactsTestHooks.installPublishedBundlerDeps(tempDir);

      const manifest = JSON.parse(await fsPromises.readFile(path.join(tempDir, 'package.json'), 'utf8')) as {
        dependencies: { mcporter: string };
      };
      expect(manifest.dependencies.mcporter).toBe('file:mcporter-fixture.tgz');
      const normalizedTempDir = await fsPromises.realpath(tempDir);
      expect(await readInvocationLog(logPath)).toEqual([
        {
          args: ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--min-release-age=0'],
          cwd: normalizedTempDir,
        },
      ]);
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('adds package context to npm installation failures', async () => {
    const tempDir = await fsPromises.mkdtemp(TMP_PREFIX);
    const binDir = await prepareFakeNpm(tempDir);
    vi.stubEnv('PATH', `${binDir}${path.delimiter}${process.env.PATH ?? ''}`);
    vi.stubEnv('FAKE_NPM_FAIL', '1');
    vi.stubEnv('MCPORTER_BUNDLER_DEP_PACKAGE', 'file:mcporter-fixture.tgz');
    try {
      await expect(artifactsTestHooks.installPublishedBundlerDeps(tempDir)).rejects.toThrow(
        'Unable to install mcporter from file:mcporter-fixture.tgz dependencies'
      );
      expect(artifactsTestHooks.formatMcporterInstallSpec(MCPORTER_VERSION)).toBe(`mcporter@${MCPORTER_VERSION}`);
    } finally {
      await fsPromises.rm(tempDir, { recursive: true, force: true });
    }
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

  it('uses the generic CLI name when the server name has no filename characters', () => {
    expect(path.basename(computeCompileTarget(true, '/tmp/bundle.js', '!!!'))).toMatch(/^mcporter-cli(?:-\d+)?$/);
  });
});

describe('resolveBundleTarget', () => {
  it('derives compile intermediates without overwriting the requested binary', () => {
    // An explicit --bundle path is returned verbatim.
    expect(resolveBundleTarget({ bundle: 'dist/custom.js', compile: 'dist/custom', outputPath: 'source.ts' })).toBe(
      'dist/custom.js'
    );
    // Both --compile forms must agree, with or without a supplied extension. The
    // arms used to diverge only on Windows (path.join there yields a backslash
    // while the extensionless arm returned the caller's string verbatim), so this
    // invariant is trivially true on POSIX and is really enforced by Windows CI.
    const distCustomJs = `${path.join('dist', 'custom')}.js`;
    const withExtension = resolveBundleTarget({ compile: 'dist/custom.bin', outputPath: 'source.ts' });
    const withoutExtension = resolveBundleTarget({ compile: 'dist/custom', outputPath: 'source.ts' });
    expect(withExtension).toBe(distCustomJs);
    expect(withoutExtension).toBe(distCustomJs);
    expect(withoutExtension).toBe(withExtension);
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
