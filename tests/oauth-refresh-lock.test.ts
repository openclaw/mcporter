import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { isFileLockTimeoutError } from '../src/fs-json.js';
import { buildOAuthPersistence } from '../src/oauth-persistence.js';
import { refreshLockDir, refreshLockPaths, withRefreshLock } from '../src/oauth-refresh-lock.js';
import { saveVaultEntry } from '../src/oauth-vault.js';

function httpDefinition(name: string, extra: Partial<ServerDefinition> = {}): ServerDefinition {
  return {
    name,
    command: { kind: 'http', url: new URL(`https://mcp.example.com/${name}`) },
    ...extra,
  } as ServerDefinition;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('oauth refresh lock', () => {
  let tempDir: string;
  let previousDataHome: string | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-refresh-lock-'));
    previousDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = path.join(tempDir, 'data');
  });

  afterEach(async () => {
    if (previousDataHome === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = previousDataHome;
    }
    delete process.env.MCPORTER_TEST_REFRESH_LOCK_TIMEOUT_MS;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('serializes concurrent transactions for the same definition', async () => {
    const definition = httpDefinition('serialize');
    const order: string[] = [];
    const firstHolding = deferred();
    const releaseFirst = deferred();

    const first = withRefreshLock(definition, async () => {
      order.push('first:enter');
      firstHolding.resolve();
      await releaseFirst.promise;
      order.push('first:exit');
    });

    await firstHolding.promise;
    const second = withRefreshLock(definition, async () => {
      order.push('second:enter');
    });

    // The waiter must not enter while the holder is inside its transaction.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual(['first:enter']);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:enter', 'first:exit', 'second:enter']);
  });

  it('does not serialize unrelated credential identities', async () => {
    const first = httpDefinition('identity-a');
    const second = httpDefinition('identity-b');
    const firstHolding = deferred();
    const releaseFirst = deferred();
    const secondEntered = deferred();

    const firstRun = withRefreshLock(first, async () => {
      firstHolding.resolve();
      await releaseFirst.promise;
    });

    await firstHolding.promise;
    const secondRun = withRefreshLock(second, async () => {
      secondEntered.resolve();
    });

    // Resolves only if the second identity acquired while the first was held.
    await secondEntered.promise;
    releaseFirst.resolve();
    await Promise.all([firstRun, secondRun]);
  });

  it('maps two definitions sharing a token cache directory to one identity', async () => {
    const cacheDir = path.join(tempDir, 'shared-cache');
    await fs.mkdir(cacheDir, { recursive: true });
    const first = httpDefinition('shared-one', { tokenCacheDir: cacheDir });
    const second = httpDefinition('shared-two', { tokenCacheDir: cacheDir });

    const [firstDirLock] = await refreshLockPaths(first);
    const [secondDirLock] = await refreshLockPaths(second);
    expect(firstDirLock).toBe(secondDirLock);
  });

  it('still serializes one definition configured with and without a token cache directory', async () => {
    const cacheDir = path.join(tempDir, 'mixed-cache');
    await fs.mkdir(cacheDir, { recursive: true });
    const cached = httpDefinition('mixed', { tokenCacheDir: cacheDir });
    const uncached = httpDefinition('mixed');

    const cachedLocks = await refreshLockPaths(cached);
    const uncachedLocks = await refreshLockPaths(uncached);

    // The cached configuration also holds the vault-key lock, which is the
    // shared token source the uncached configuration reads.
    expect(cachedLocks).toHaveLength(2);
    expect(uncachedLocks).toHaveLength(1);
    expect(cachedLocks).toContain(uncachedLocks[0]);

    const order: string[] = [];
    const cachedHolding = deferred();
    const releaseCached = deferred();

    const cachedRun = withRefreshLock(cached, async () => {
      order.push('cached:enter');
      cachedHolding.resolve();
      await releaseCached.promise;
      order.push('cached:exit');
    });

    await cachedHolding.promise;
    const uncachedRun = withRefreshLock(uncached, async () => {
      order.push('uncached:enter');
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual(['cached:enter']);

    releaseCached.resolve();
    await Promise.all([cachedRun, uncachedRun]);
    expect(order).toEqual(['cached:enter', 'cached:exit', 'uncached:enter']);
  });

  it('shares a lock between a renamed server and the legacy entry it inherits', async () => {
    const url = new URL('https://mcp.example.com/inherited');
    const renamed = { name: 'inherited', command: { kind: 'http', url } } as ServerDefinition;
    const legacy = { name: 'inherited-oauth', command: { kind: 'http', url } } as ServerDefinition;

    // The legacy entry holds the credentials the renamed definition inherits.
    await saveVaultEntry(legacy, {
      tokens: { access_token: 'inherited-access', token_type: 'Bearer', refresh_token: 'inherited-refresh' },
    });

    const renamedLocks = await refreshLockPaths(renamed);
    const legacyLocks = await refreshLockPaths(legacy);

    // The sets need not match; they must overlap on the shared credential's key.
    expect(legacyLocks).toHaveLength(1);
    expect(renamedLocks).toContain(legacyLocks[0]);
    expect(renamedLocks.length).toBeGreaterThan(1);

    const order: string[] = [];
    const holding = deferred();
    const release = deferred();
    const holder = withRefreshLock(renamed, async () => {
      order.push('renamed:enter');
      holding.resolve();
      await release.promise;
      order.push('renamed:exit');
    });
    await holding.promise;

    const waiter = withRefreshLock(legacy, async () => {
      order.push('legacy:enter');
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Redeeming here would replay the refresh token the other config is rotating.
    expect(order).toEqual(['renamed:enter']);

    release.resolve();
    await Promise.all([holder, waiter]);
    expect(order).toEqual(['renamed:enter', 'renamed:exit', 'legacy:enter']);
  });

  it('sorts lock targets so overlapping sets cannot invert', async () => {
    const url = new URL('https://mcp.example.com/ordering');
    const cacheDir = path.join(tempDir, 'ordering-cache');
    await fs.mkdir(cacheDir, { recursive: true });
    const renamed = { name: 'ordering', command: { kind: 'http', url }, tokenCacheDir: cacheDir } as ServerDefinition;
    await saveVaultEntry({ name: 'ordering-oauth', command: { kind: 'http', url } } as ServerDefinition, {
      tokens: { access_token: 'a', token_type: 'Bearer' },
    });

    const locks = await refreshLockPaths(renamed);
    expect(locks).toHaveLength(3);
    expect(locks).toEqual(locks.toSorted());
  });

  it('resolves relative and absolute spellings of one token path to one identity', async () => {
    const cacheDir = path.join(tempDir, 'spelling-cache');
    await fs.mkdir(cacheDir, { recursive: true });
    const absolute = httpDefinition('spelling', { tokenCacheDir: cacheDir });
    const indirect = httpDefinition('spelling', { tokenCacheDir: path.join(cacheDir, '..', 'spelling-cache') });

    expect(await refreshLockPaths(indirect)).toEqual(await refreshLockPaths(absolute));
  });

  it.runIf(process.platform !== 'win32')('resolves a symlinked token path to one identity', async () => {
    const realDir = path.join(tempDir, 'real-cache');
    const linkDir = path.join(tempDir, 'linked-cache');
    await fs.mkdir(realDir, { recursive: true });
    await fs.symlink(realDir, linkDir);

    const direct = httpDefinition('symlinked', { tokenCacheDir: realDir });
    const viaLink = httpDefinition('symlinked', { tokenCacheDir: linkDir });

    expect(await refreshLockPaths(viaLink)).toEqual(await refreshLockPaths(direct));
  });

  it('keeps lock filenames free of separators and credential material', async () => {
    const definition = httpDefinition('../../weird name:with|chars');
    const lockPaths = await refreshLockPaths(definition);
    const lockPath = lockPaths[0] ?? '';
    const basename = path.basename(lockPath);

    expect(path.dirname(lockPath)).toBe(refreshLockDir());
    expect(basename).not.toContain('|');
    expect(basename).not.toContain(':');
    expect(basename).not.toContain('/');
    expect(basename).not.toContain('\\');
    expect(basename).not.toMatch(/^\.\./);
    expect(basename).not.toContain('mcp.example.com');
    expect(path.resolve(refreshLockDir(), basename)).toBe(lockPath);
  });

  it('derives a stable identity across calls', async () => {
    const definition = httpDefinition('stable');
    expect(await refreshLockPaths(definition)).toEqual(await refreshLockPaths(definition));
  });

  it('throws a recognizable timeout error when acquisition exceeds its budget', async () => {
    const definition = httpDefinition('timeout');
    const holding = deferred();
    const release = deferred();

    const holder = withRefreshLock(definition, async () => {
      holding.resolve();
      await release.promise;
    });

    await holding.promise;
    const waiter = withRefreshLock(definition, async () => 'never', { timeoutMs: 50 });
    await expect(waiter).rejects.toSatisfy(isFileLockTimeoutError);

    release.resolve();
    await holder;
  });

  it('does not classify unrelated failures as lock timeouts', () => {
    expect(isFileLockTimeoutError(new Error('ENOSPC: no space left on device'))).toBe(false);
    expect(isFileLockTimeoutError(undefined)).toBe(false);
  });

  it('honors the test-only timeout override from the environment', async () => {
    process.env.MCPORTER_TEST_REFRESH_LOCK_TIMEOUT_MS = '40';
    const definition = httpDefinition('env-timeout');
    const holding = deferred();
    const release = deferred();

    const holder = withRefreshLock(definition, async () => {
      holding.resolve();
      await release.promise;
    });

    await holding.promise;
    const startedAt = Date.now();
    await expect(withRefreshLock(definition, async () => 'never')).rejects.toSatisfy(isFileLockTimeoutError);
    expect(Date.now() - startedAt).toBeLessThan(5_000);

    release.resolve();
    await holder;
  });

  it('treats a nested acquisition of a held identity as a passthrough', async () => {
    const definition = httpDefinition('reentrant');

    const result = await withRefreshLock(definition, async () => {
      // Mirrors the SDK reading tokens through the provider while the outer
      // wrapper holds the lock. Without passthrough this waits for the timeout.
      return await withRefreshLock(definition, async () => 'inner-ran', { timeoutMs: 250 });
    });

    expect(result).toBe('inner-ran');
  });

  it('allows persistence writes inside the transaction without deadlocking', async () => {
    const definition = httpDefinition('persist-inside-lock');
    const persistence = await buildOAuthPersistence(definition);

    await withRefreshLock(definition, async () => {
      await persistence.saveTokens({ access_token: 'inside-lock', token_type: 'Bearer' });
    });

    const tokens = await persistence.readTokens();
    expect(tokens?.access_token).toBe('inside-lock');
  });
});
