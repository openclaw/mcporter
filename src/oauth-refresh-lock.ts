import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import path from 'node:path';
import type { ServerDefinition } from './config.js';
import { canonicalizeFilePath, withFileLock } from './fs-json.js';
import { vaultCredentialKeys } from './oauth-vault.js';
import { mcporterDir } from './paths.js';

/**
 * Serializes the whole OAuth refresh transaction — re-read, redeem, persist —
 * across processes, per credential identity.
 *
 * The vault write lock cannot do this job: the locked section calls saveTokens,
 * which takes that lock itself. Without a separate transaction lock, two
 * processes read the same expired token and redeem the same rotating refresh
 * token; providers that detect replay revoke the whole token family.
 */

const REFRESH_LOCK_DIR = 'refresh-locks';
const LOCK_LABEL_MAX = 40;
const IDENTITY_HASH_LENGTH = 16;

// Test-only: lets the multi-process suite construct a waiter-timeout case
// inside its budgets. This is not the deferred user-facing setting.
const TIMEOUT_OVERRIDE_ENV = 'MCPORTER_TEST_REFRESH_LOCK_TIMEOUT_MS';

// Lock paths held by the current call chain. The MCP SDK's auth() reads tokens
// through the provider while an outer wrapper already holds the lock, and
// withFileLock is not re-entrant per key, so a nested acquisition would queue
// behind its own holder until the acquisition timeout.
const heldLockPaths = new AsyncLocalStorage<ReadonlySet<string>>();

export interface RefreshLockOptions {
  /** Overrides the acquisition timeout. Test-only; see TIMEOUT_OVERRIDE_ENV. */
  timeoutMs?: number;
}

export function refreshLockDir(): string {
  return path.join(mcporterDir('data'), REFRESH_LOCK_DIR);
}

/**
 * Derives the lock file paths for a credential, in acquisition order.
 *
 * A credential reachable through more than one place must serialize as one
 * identity, and there are two such axes. The composite persistence writes every
 * store and falls back to the vault on reads, so a server configured with a
 * token cache directory shares its vault-persisted token with the same server
 * configured without one. Separately, a renamed server inherits the credentials
 * of its legacy `<name>-oauth` vault entry, so both configurations can resolve
 * to one refresh token under different vault keys.
 *
 * Every reachable target is locked, and the set is sorted so that all
 * configurations acquire shared targets in the same order. Two definitions need
 * not derive identical sets — they only have to overlap on the target holding
 * the credential they share — but a total order is what keeps overlapping sets
 * from inverting into a deadlock.
 */
export async function refreshLockPaths(definition: ServerDefinition): Promise<string[]> {
  const paths: string[] = [];
  if (definition.tokenCacheDir) {
    const tokenPath = await canonicalizeFilePath(path.join(definition.tokenCacheDir, 'tokens.json'));
    paths.push(lockPathFor(path.basename(path.dirname(tokenPath)), `dir:${tokenPath}`));
  }
  for (const vaultKey of await vaultCredentialKeys(definition)) {
    // Label from the key's own server name, never the calling definition's: a
    // renamed server and its legacy entry must land on one filename for the key
    // they share, or they would take separate locks over one refresh token.
    paths.push(lockPathFor(vaultKey.split('|')[0] ?? '', `vault:${vaultKey}`));
  }
  return [...new Set(paths)].toSorted();
}

export async function withRefreshLock<T>(
  definition: ServerDefinition,
  task: () => Promise<T>,
  options: RefreshLockOptions = {}
): Promise<T> {
  const lockPaths = await refreshLockPaths(definition);
  return await acquireAll(lockPaths, task, resolveTimeoutMs(options.timeoutMs));
}

async function acquireAll<T>(lockPaths: string[], task: () => Promise<T>, timeoutMs?: number): Promise<T> {
  const held = heldLockPaths.getStore();
  const pending = held ? lockPaths.filter((lockPath) => !held.has(lockPath)) : lockPaths;
  if (pending.length === 0) {
    return await task();
  }

  const nextHeld = new Set([...(held ?? []), ...pending]);
  return await heldLockPaths.run(nextHeld, async () => {
    // Compose inner-to-outer so the first pending path is the outermost lock.
    let run = task;
    for (const lockPath of pending.toReversed()) {
      const inner = run;
      run = async () => await withFileLock(lockPath, inner, timeoutMs === undefined ? {} : { timeoutMs });
    }
    return await run();
  });
}

function resolveTimeoutMs(explicit?: number): number | undefined {
  if (explicit !== undefined) {
    return explicit;
  }
  const raw = process.env[TIMEOUT_OVERRIDE_ENV];
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Hashes the identity into the filename. The identity can embed a filesystem
 * path and a user-chosen server name, so it carries separators, drive colons,
 * and the vault key's '|' — none of which may reach a filename.
 *
 * The label is only a debugging aid, but it must be derived from the identity
 * rather than from the calling definition: two definitions that share one token
 * store have to land on the same filename, or they would take separate locks
 * and could still redeem the same refresh token concurrently.
 */
function lockPathFor(label: string, identity: string): string {
  const digest = crypto.createHash('sha256').update(identity).digest('hex').slice(0, IDENTITY_HASH_LENGTH);
  const safeLabel = filenameSafeLabel(label);
  return path.join(refreshLockDir(), safeLabel.length > 0 ? `${safeLabel}-${digest}` : digest);
}

function filenameSafeLabel(value: string): string {
  return value
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._-]+/, '')
    .slice(0, LOCK_LABEL_MAX);
}
