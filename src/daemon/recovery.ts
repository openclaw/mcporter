import fs from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { FileLockTimeoutError, withFileLock } from '../fs-json.js';
import { launchDaemonDetached, type DaemonLaunchOptions } from './launch.js';
import { readLifecycle, writeLifecycle, recoveryLockPath, type ManagedOwner } from './lifecycle-state.js';
import { retireManagedOwner } from './managed-owner.js';
import { resolveServiceReference, generationExitPath } from './service-manager.js';
import { sendBootstrap } from './bootstrap.js';
import { waitForDaemonReady } from './startup-readiness.js';
import type { StatusResult } from './protocol.js';

const WINDOW_MS = 60_000;
const MAX_STARTS = 3;
const isAbsence = (error: unknown) =>
  !!error &&
  typeof error === 'object' &&
  'code' in error &&
  ['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT'].includes(String(error.code));

/** Revoke admission before inspecting or retiring a partially launched generation. */
async function fenceOwner(metadataPath: string): Promise<ManagedOwner | undefined> {
  const fence = () =>
    withFileLock(
      metadataPath,
      async () => {
        const state = await readLifecycle();
        if (state.active) {
          state.active.phase = 'retiring';
          await writeLifecycle(state);
        }
        return state.active;
      },
      { timeoutMs: 1500 }
    );
  try {
    return await fence();
  } catch (error) {
    if (!(error instanceof FileLockTimeoutError)) throw error;
    // A frozen worker may hold its publication lock; the OS backend can still retire it.
    const state = await readLifecycle();
    if (!state.active?.identity && !state.active?.service) throw error;
    await retireManagedOwner(state.active);
    return fence();
  }
}

/** Coordinates daemon ownership, never a tool operation or its replay. */
export async function ensureDaemonRunning(
  options: DaemonLaunchOptions,
  probe: (timeoutMs: number) => Promise<StatusResult | null>
): Promise<void> {
  const rawObserve = async () => {
    try {
      return await probe(2000);
    } catch (error) {
      if (isAbsence(error)) return null;
      throw error;
    }
  };
  const observe = async () => {
    const status = await rawObserve();
    if (!status) return null;
    const state = await readLifecycle();
    if (state.active && (state.active.phase !== 'ready' || state.active.generation !== status.generation)) return null;
    return status;
  };
  if (await observe()) return;
  let foregroundGeneration: string | undefined;
  let cancelled = false;
  const stop = () => {
    cancelled = true;
    process.exitCode = 130;
    void (async () => {
      const snapshot = (await readLifecycle()).active;
      if (!snapshot || snapshot.generation !== foregroundGeneration || (!snapshot.identity && !snapshot.service))
        return;
      try {
        await withFileLock(
          options.metadataPath,
          async () => {
            const state = await readLifecycle();
            if (!state.active || state.active.generation !== foregroundGeneration) return;
            state.active.phase = 'retiring';
            await writeLifecycle(state);
          },
          { timeoutMs: 1500 }
        );
      } catch (error) {
        if (!(error instanceof FileLockTimeoutError)) throw error;
      }
      // Foreground shutdown requests retirement only; namespace unlink belongs to the elected coordinator.
      await retireManagedOwner(snapshot, false);
    })().catch(() => {});
  };
  if (options.foreground) {
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }
  try {
    const launched = await withFileLock(
      recoveryLockPath(),
      async () => {
        // A waiter gets its own bounded leader budget only after winning coordination.
        const deadline = Date.now() + 60_000;
        if (cancelled) return undefined;
        for (let probeAttempt = 0; probeAttempt < 2; probeAttempt++) {
          if (await observe()) return undefined;
          if (probeAttempt === 0) await new Promise((resolve) => setTimeout(resolve, 250));
        }
        let lastError: unknown;
        for (let attempt = 0; attempt < 2; attempt++) {
          if (cancelled) return undefined;
          if (Date.now() >= deadline) throw new Error('Daemon recovery deadline exceeded.');
          const previous = await fenceOwner(options.metadataPath);
          if (previous && (previous.identity || previous.service)) await retireManagedOwner(previous);
          else if (
            !previous &&
            (await fs.lstat(options.metadataPath).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== 'ENOENT') throw error;
              return undefined;
            }))
          )
            throw new Error(
              'Previous installation has no managed process ownership. Drain it before upgrading; already-crashed legacy state requires manual process inspection.'
            );
          if (Date.now() >= deadline) throw new Error('Daemon recovery deadline exceeded.');
          const generation = randomUUID();
          foregroundGeneration = generation;
          await withFileLock(
            options.metadataPath,
            async () => {
              const latest = await readLifecycle();
              if (latest.active?.generation !== previous?.generation)
                throw new Error('Daemon ownership changed during recovery.');
              if (previous?.cleanExit) latest.attempts = [];
              latest.attempts = latest.attempts.filter((time) => Date.now() - time < WINDOW_MS);
              if (latest.attempts.length >= MAX_STARTS)
                throw new Error(
                  'Daemon restart limit reached (3 starts in 60 seconds); inspect startup errors before retrying.'
                );
              await fs.unlink(options.metadataPath).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== 'ENOENT') throw error;
              });
              if (process.platform !== 'win32')
                await fs.unlink(options.socketPath).catch((error: NodeJS.ErrnoException) => {
                  if (error.code !== 'ENOENT') throw error;
                });
              latest.attempts.push(Date.now());
              latest.active = {
                generation,
                kind: process.platform === 'win32' ? 'windows' : 'posix',
                ...(process.platform === 'win32' ? {} : { service: await resolveServiceReference(generation) }),
                phase: 'starting',
                startedAt: Date.now(),
              };
              await writeLifecycle(latest);
            },
            { timeoutMs: 1500 }
          );
          try {
            if (cancelled) throw new Error('Foreground daemon start cancelled.');
            const child = await launchDaemonDetached({ ...options, generation });
            let initialized = false;
            await waitForDaemonReady(async () => {
              if (cancelled) throw new Error('Foreground daemon start cancelled.');
              if (Date.now() >= deadline) throw new Error('Daemon recovery deadline exceeded.');
              const alreadyReady = await rawObserve();
              if (alreadyReady) {
                if (alreadyReady.generation !== generation)
                  throw new Error('Unexpected daemon generation during startup.');
                return alreadyReady;
              }
              if (!initialized && (await readLifecycle()).active?.phase === 'starting') {
                try {
                  await sendBootstrap(options.socketPath, generation);
                  initialized = true;
                } catch (error) {
                  if (!isAbsence(error)) throw error;
                  return null;
                }
              }
              if (cancelled) throw new Error('Foreground daemon start cancelled.');
              if (Date.now() >= deadline) throw new Error('Daemon recovery deadline exceeded.');
              const status = await rawObserve();
              if (status && status.generation !== generation)
                throw new Error('Unexpected daemon generation during startup.');
              if (!status && (child.exitCode !== null || child.signalCode !== null))
                throw new Error('Daemon exited before becoming ready.');
              return status;
            });
            return child;
          } catch (error) {
            lastError = error;
            const current = await fenceOwner(options.metadataPath);
            if (current?.generation === generation && (current.identity || current.service))
              await retireManagedOwner(current);
            if (cancelled) return undefined;
            const cause = error instanceof Error ? (error.cause as NodeJS.ErrnoException | undefined) : undefined;
            if (cause && ['ENOENT', 'EACCES', 'ENOEXEC'].includes(cause.code ?? '')) throw error;
            if (attempt === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
            else break;
          }
        }
        throw new Error('Daemon recovery failed after bounded startup attempts.', { cause: lastError });
      },
      { timeoutMs: 65_000 }
    );
    if (options.foreground && launched) {
      let code: number;
      if (launched.waitForExit) code = await launched.waitForExit();
      else {
        let exitCode = launched.exitCode,
          signal = launched.signalCode;
        if (exitCode === null && signal === null)
          [exitCode, signal] = (await once(launched, 'exit')) as [number | null, NodeJS.Signals | null];
        code = exitCode ?? (signal ? 128 + (os.constants.signals[signal] ?? 1) : 1);
        if (foregroundGeneration) {
          const receipt = (await fs
            .readFile(generationExitPath(foregroundGeneration), 'utf8')
            .then(JSON.parse)
            .catch(() => undefined)) as { generation?: string; code?: number } | undefined;
          if (receipt?.generation === foregroundGeneration && Number.isInteger(receipt.code)) code = receipt.code!;
        }
      }
      if (!cancelled) process.exitCode = code;
    }
  } finally {
    if (options.foreground) {
      process.off('SIGINT', stop);
      process.off('SIGTERM', stop);
    }
  }
}

/** Explicit stop is coordinated with replacement and includes OS-owned orphan cleanup. */
export async function stopManagedDaemon(options: DaemonLaunchOptions, stopRpc: () => Promise<void>): Promise<void> {
  await withFileLock(
    recoveryLockPath(),
    async () => {
      const owner = (await readLifecycle()).active;
      await stopRpc();
      if (!owner) return;
      const fenced = await fenceOwner(options.metadataPath);
      if (!fenced || fenced.generation !== owner.generation) throw new Error('Daemon generation changed during stop.');
      if (fenced.identity || fenced.service) await retireManagedOwner(fenced);
      await withFileLock(options.metadataPath, async () => {
        const state = await readLifecycle();
        if (state.active?.generation !== owner.generation) return;
        state.active.cleanExit = true;
        state.active.phase = 'retiring';
        await writeLifecycle(state);
        const metadata = (await fs
          .readFile(options.metadataPath, 'utf8')
          .then(JSON.parse)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
            return undefined;
          })) as { generation?: string } | undefined;
        if (metadata && metadata.generation !== owner.generation)
          throw new Error('Daemon metadata changed during stop.');
        if (metadata) await fs.unlink(options.metadataPath);
        if (process.platform !== 'win32')
          await fs.unlink(options.socketPath).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
          });
      });
    },
    { timeoutMs: 65000 }
  );
}
