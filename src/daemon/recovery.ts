import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { withFileLock } from '../fs-json.js';
import { isBootIdentity, readBootIdentity } from './boot-identity.js';
import { assertLegacyDrained } from './migration.js';
import { getDaemonMetadataPath, getDaemonSocketPath, secureDaemonDirectory } from './paths.js';
import { DAEMON_PROTOCOL_VERSION } from './protocol.js';
import { requestDaemon } from './socket-rpc.js';

async function inspectArtifact(file: string, kind: 'metadata' | 'socket' | 'lock' = 'metadata'): Promise<boolean> {
  const info = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return undefined;
  });
  if (!info) return false;
  if (
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    info.nlink !== 1 ||
    (kind !== 'lock' && (info.mode & 0o022) !== 0) ||
    (kind === 'socket' ? !info.isSocket() : !info.isFile())
  )
    throw new Error('Unsafe daemon recovery artifact; no state was cleared.');
  return true;
}

/** Clears only confirmed prior-boot ownership; never starts a host or replays an operation. */
export async function recoverDaemon(): Promise<string | undefined> {
  await secureDaemonDirectory();
  const boot = await readBootIdentity();
  if (!boot)
    throw new Error('Daemon recovery requires a kernel boot identity on Linux or macOS; no state was cleared.');
  await assertLegacyDrained();
  const metadataPath = getDaemonMetadataPath();
  const socketPath = getDaemonSocketPath();
  // withFileLock follows symlinks for general config files. Singleton recovery must not.
  await inspectArtifact(metadataPath);
  // Generic locks inherit umask; the verified owner-only directory protects their entries.
  for (const file of [`${metadataPath}.lock`, `${metadataPath}.lock.break`]) await inspectArtifact(file, 'lock');
  return withFileLock(metadataPath, async () => {
    const exists = await inspectArtifact(metadataPath);
    await inspectArtifact(socketPath, 'socket');
    let unavailable = false;
    try {
      await requestDaemon(
        socketPath,
        {
          id: randomUUID(),
          method: 'status',
          params: {},
          protocolVersion: DAEMON_PROTOCOL_VERSION,
        },
        1000
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ECONNREFUSED') throw error;
      unavailable = true;
    }
    if (!unavailable) throw new Error('A responding daemon owns this namespace; recovery refused.');
    if (!exists) return undefined;
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8')) as {
      pid?: unknown;
      socketPath?: unknown;
      protocolVersion?: unknown;
      bootIdentity?: unknown;
    } | null;
    if (
      !metadata ||
      !Number.isSafeInteger(metadata.pid) ||
      (metadata.pid as number) <= 0 ||
      metadata.socketPath !== socketPath ||
      metadata.protocolVersion !== DAEMON_PROTOCOL_VERSION ||
      !isBootIdentity(metadata.bootIdentity) ||
      metadata.bootIdentity.platform !== boot.platform
    )
      throw new Error('Daemon metadata lacks compatible boot evidence; no state was cleared.');
    if (metadata.bootIdentity.id === boot.id)
      throw new Error('Same-boot daemon retirement is unverified; recovery refused. No state was cleared.');
    // A changed kernel boot UUID proves local processes from that boot cannot survive,
    // even if an unrelated process has reused the PID. It says nothing about remote outcomes.
    await fs.unlink(socketPath).catch((failure: NodeJS.ErrnoException) => {
      if (failure.code !== 'ENOENT') throw failure;
    });
    const archive = `${metadataPath}.recovered-${randomUUID()}`;
    await fs.rename(metadataPath, archive);
    return archive;
  });
}
