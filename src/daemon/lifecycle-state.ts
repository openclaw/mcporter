import fs from 'node:fs/promises';
import path from 'node:path';
import { writeJsonFile, withFileLock } from '../fs-json.js';
import { daemonRunDir, getDaemonMetadataPath } from './paths.js';
import type { ProcessIdentity } from './process-retirement.js';

export interface ManagedOwner {
  generation: string;
  startedAt: number;
  kind: 'posix' | 'windows';
  phase: 'starting' | 'ready' | 'retiring';
  identity?: ProcessIdentity;
  guardSocket?: string;
  jobName?: string;
  cleanExit?: boolean;
  anchorBornUtc?: string;
}
export interface LifecycleState {
  version: 1;
  attempts: number[];
  active?: ManagedOwner;
}
export const isGeneration = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
export const lifecyclePath = () => path.join(daemonRunDir(), 'lifecycle.json');
export const recoveryLockPath = () => path.join(daemonRunDir(), 'recovery');
export function guardSocketPath(generation: string): string {
  if (!isGeneration(generation)) throw new Error('Invalid daemon generation.');
  return path.join(daemonRunDir(), 'g.sock');
}

export async function readLifecycle(): Promise<LifecycleState> {
  const file = lifecyclePath();
  const info = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (!info) return { version: 1, attempts: [] };
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1 ||
    (process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0))
  )
    throw new Error('Unsafe daemon lifecycle state.');
  let value: LifecycleState;
  try {
    value = JSON.parse(await fs.readFile(file, 'utf8')) as LifecycleState;
  } catch (error) {
    throw new Error('Invalid daemon lifecycle state.', { cause: error });
  }
  if (
    !value ||
    value.version !== 1 ||
    !Array.isArray(value.attempts) ||
    value.attempts.length > 3 ||
    value.attempts.some((time) => !Number.isFinite(time) || time <= 0)
  )
    throw new Error('Invalid daemon lifecycle state.');
  const owner = value.active;
  if (
    owner &&
    (!isGeneration(owner.generation) ||
      !Number.isFinite(owner.startedAt) ||
      !['starting', 'ready', 'retiring'].includes(owner.phase) ||
      (owner.kind !== 'posix' && owner.kind !== 'windows') ||
      (owner.anchorBornUtc !== undefined && (typeof owner.anchorBornUtc !== 'string' || !owner.anchorBornUtc)) ||
      (owner.cleanExit !== undefined && typeof owner.cleanExit !== 'boolean') ||
      (owner.guardSocket !== undefined && owner.guardSocket !== guardSocketPath(owner.generation)) ||
      (owner.jobName !== undefined && owner.jobName !== `Global\\MCPorter-${owner.generation}`) ||
      (owner.identity &&
        (!Number.isSafeInteger(owner.identity.pid) ||
          owner.identity.pid <= 0 ||
          typeof owner.identity.owner !== 'string' ||
          typeof owner.identity.born !== 'string' ||
          !owner.identity.born)))
  )
    throw new Error('Invalid daemon ownership state.');
  return value;
}
export async function writeLifecycle(value: LifecycleState): Promise<void> {
  await writeJsonFile(lifecyclePath(), value);
}
export async function updateOwner(generation: string, patch: Partial<ManagedOwner>): Promise<void> {
  await withFileLock(
    getDaemonMetadataPath(),
    async () => {
      const state = await readLifecycle();
      if (state.active?.generation !== generation || state.active.phase === 'retiring')
        throw new Error('Daemon launch reservation expired.');
      if (patch.identity && state.active.identity && patch.identity.pid !== state.active.identity.pid)
        throw new Error('Daemon generation already has an owner.');
      Object.assign(state.active, patch);
      await writeLifecycle(state);
    },
    { timeoutMs: 5000 }
  );
}

export const jobProofPath = (generation: string) => {
  if (!isGeneration(generation)) throw new Error('Invalid daemon generation.');
  return path.join(daemonRunDir(), `job-${generation}.json`);
};
