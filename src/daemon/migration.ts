import { ensureWindowsPrivateDirectory } from '../chrome-devtools-relay-handoff.js';
import { ownedProcessTree, awaitRetirement, type ProcessIdentity } from './process-retirement.js';
import { writeJsonFile } from '../fs-json.js';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isProcessRunning } from '../process-utils.js';
import { mcporterDir } from '../paths.js';
import { daemonRunDir, secureDaemonDirectory } from './paths.js';
import type { DaemonResponse, StatusResult } from './protocol.js';
import { BrokerError } from './broker.js';

export async function probeDaemon(socketPath: string, method = 'status'): Promise<StatusResult | boolean | null> {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    let done = false;
    const finish = (value: StatusResult | boolean | null) => {
      if (!done) {
        done = true;
        socket.destroy();
        resolve(value);
      }
    };
    socket.setTimeout(1000, () => finish(null));
    socket.on('error', () => finish(null));
    socket.on('connect', () => socket.write(JSON.stringify({ id: randomUUID(), method, params: {} })));
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 1024 * 1024) {
        finish(null);
        return;
      }
      try {
        const response = JSON.parse(buffer.trim()) as DaemonResponse<StatusResult | boolean>;
        finish(response.ok ? (response.result ?? null) : null);
      } catch {
        /* Incomplete frame. */
      }
    });
    socket.on('end', () => finish(null));
  });
}

export async function legacyDaemons(): Promise<Array<{ pid: number; socketPath: string; verified: boolean }>> {
  const dirs = new Set([daemonRunDir()]);
  if (!process.env.MCPORTER_DAEMON_DIR) dirs.add(path.join(mcporterDir('state'), 'daemon'));
  const result: Array<{ pid: number; socketPath: string; verified: boolean }> = [];
  for (const dir of dirs) {
    if (process.platform === 'win32') {
      if (dir === daemonRunDir()) await secureDaemonDirectory();
      else ensureWindowsPrivateDirectory(dir, true);
    }
    const files = await fs.readdir(dir).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const name of files.filter((file) => /^daemon-[a-f0-9]+\.json$/.test(file))) {
      const file = path.join(dir, name);
      const info = await fs.lstat(file);
      if (!info.isFile() || (process.platform !== 'win32' && info.uid !== process.getuid?.()))
        throw new BrokerError(
          'legacy_daemon_unverified',
          'Legacy daemon metadata ownership cannot be verified. Resolve it manually before cutover.'
        );
      const data = JSON.parse(await fs.readFile(file, 'utf8')) as { pid: number; socketPath: string };
      if (!Number.isSafeInteger(data.pid) || data.pid <= 0 || typeof data.socketPath !== 'string')
        throw new BrokerError('legacy_daemon_unverified', 'Malformed legacy metadata requires manual inspection.');
      if (!isProcessRunning(data.pid)) continue;
      const expected =
        process.platform === 'win32'
          ? `\\\\.\\pipe\\mcporter-${name.slice(0, -5)}`
          : path.join(dir, name.replace(/\.json$/, '.sock'));
      const live = data.socketPath === expected ? await probeDaemon(expected) : null;
      const verified =
        !!live &&
        typeof live === 'object' &&
        live.pid === data.pid &&
        live.socketPath === expected &&
        (live.protocolVersion ?? 1) < 3;
      result.push({ pid: data.pid, socketPath: expected, verified });
    }
  }
  return result;
}

export async function assertLegacyDrained(): Promise<void> {
  if (await fs.stat(path.join(daemonRunDir(), 'legacy-retirement.json')).catch(() => undefined))
    throw new BrokerError(
      'legacy_retirement_pending',
      'Legacy retirement is unverified; inspect daemon migrate before cutover.'
    );
  if ((await legacyDaemons()).length)
    throw new BrokerError(
      'legacy_daemon_conflict',
      'Live legacy per-config daemon ownership remains. Upgrade all invoking clients, drain old calls, then run daemon migrate --stop-legacy --confirmed-drained. No process was stopped.'
    );
}

export async function stopVerifiedLegacyDaemons(): Promise<void> {
  const marker = path.join(daemonRunDir(), 'legacy-retirement.json');
  const pending = await fs
    .readFile(marker, 'utf8')
    .then((raw) => JSON.parse(raw) as { processes: ProcessIdentity[] })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
      return undefined;
    });
  if (pending) {
    if (
      !Array.isArray(pending.processes) ||
      pending.processes.length === 0 ||
      !pending.processes.every(
        (p) => Number.isSafeInteger(p.pid) && p.pid > 0 && typeof p.born === 'string' && typeof p.owner === 'string'
      )
    )
      throw new Error('Invalid legacy retirement marker; manual inspection required.');
    await awaitRetirement(pending.processes);
    await fs.unlink(marker);
  }
  const legacy = await legacyDaemons();
  if (legacy.some((entry) => !entry.verified))
    throw new BrokerError(
      'legacy_daemon_unverified',
      'Legacy process ownership is unverified; no process was stopped.'
    );
  for (const entry of legacy) {
    // Reverify immediately before sending the protocol stop; never signal a metadata PID.
    const live = await probeDaemon(entry.socketPath);
    if (!live || typeof live !== 'object' || live.pid !== entry.pid || live.socketPath !== entry.socketPath)
      throw new BrokerError('legacy_daemon_unverified', 'Legacy owner changed during cutover.');
    const processes = await ownedProcessTree(entry.pid);
    await writeJsonFile(marker, { processes });
    if (!(await probeDaemon(entry.socketPath, 'stop')))
      throw new BrokerError(
        'legacy_stop_failed',
        'Verified legacy daemon did not accept stop; retirement remains blocked.'
      );
    await awaitRetirement(processes);
    await fs.unlink(marker);
  }
}
