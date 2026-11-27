import fs from 'node:fs/promises';
import net from 'node:net';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { buildDaemonLaunchInvocation, type DaemonLaunchOptions } from './launch.js';
import { DAEMON_PROTOCOL_VERSION, type DaemonRequest } from './protocol.js';
import { authenticateServer, daemonKey, requestDaemon, SocketFrames } from './socket-rpc.js';
import { processInventory } from './process-retirement.js';
import { guardSocketPath, readLifecycle, updateOwner, jobProofPath, type ManagedOwner } from './lifecycle-state.js';
import { attachWindowsJob, inspectWindowsJob } from './windows-job.js';

const exec = promisify(execFile);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function retireManagedOwner(owner: ManagedOwner, cleanupArtifacts = true): Promise<void> {
  if (owner.kind === 'windows') {
    if (!owner.jobName || !owner.identity) throw new Error('Windows daemon ownership setup is incomplete.');
    const deadlineForProof = Date.now() + 15_000;
    while (true) {
      const raw = await fs.readFile(jobProofPath(owner.generation), 'utf8').catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
        return undefined;
      });
      if (raw) {
        const proof = JSON.parse(raw) as { generation?: string; name?: string; pid?: number };
        if (proof.generation !== owner.generation || proof.name !== owner.jobName || proof.pid !== owner.identity.pid)
          throw new Error('Unverified Windows job capability; no job was terminated.');
        break;
      }
      const inventory = await processInventory([owner.identity.pid]);
      const current = inventory.processes.find((item) => item.pid === owner.identity!.pid);
      if (!current || (current.born && current.born !== owner.identity.born)) return;
      if (Date.now() >= deadlineForProof)
        throw new Error('Windows daemon did not finish ownership setup; no unverified job was terminated.');
      await pause(100);
    }
    await inspectWindowsJob(owner.jobName, true);
    const deadline = Date.now() + 15_000;
    while (await inspectWindowsJob(owner.jobName)) {
      if (Date.now() >= deadline) throw new Error('Windows daemon job did not retire.');
      await pause(100);
    }
    if (cleanupArtifacts)
      await fs.unlink(jobProofPath(owner.generation)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    return;
  }
  if (!owner.identity || !owner.guardSocket) throw new Error('Daemon ownership setup is incomplete.');
  try {
    const result = await requestDaemon<{ role: string; generation: string }>(
      owner.guardSocket,
      {
        id: randomUUID(),
        method: 'stop',
        generation: owner.generation,
        params: {},
        protocolVersion: DAEMON_PROTOCOL_VERSION,
      },
      1500,
      1500
    );
    if (!result.ok || result.result?.role !== 'guardian' || result.result.generation !== owner.generation)
      throw new Error('Unverified daemon guardian; retirement refused.');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ECONNREFUSED' && code !== 'ECONNRESET') throw error;
  }
  const deadline = Date.now() + 5000;
  while (!(await posixGroupRetired(owner))) {
    if (Date.now() >= deadline)
      throw new Error('Daemon guardian or its group has not retired; no saved PID was signalled.');
    await pause(50);
  }
  if (cleanupArtifacts)
    await fs.unlink(owner.guardSocket).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
}
async function posixAnchor(pid: number): Promise<{ pgid: number; owner: string; born: string } | undefined> {
  try {
    const { stdout } = await exec('ps', ['-p', String(pid), '-o', 'pgid=', '-o', 'uid=', '-o', 'lstart='], {
      timeout: 2000,
      env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' },
    });
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(stdout);
    if (!match) throw new Error('Invalid daemon anchor observation.');
    return { pgid: Number(match[1]), owner: match[2]!, born: match[3]! };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string };
    if (failure.code === 1 && !failure.stdout?.trim()) return undefined;
    throw error;
  }
}
async function posixGroupRetired(owner: ManagedOwner): Promise<boolean> {
  const identity = owner.identity!;
  const current = await posixAnchor(identity.pid);
  // POSIX cannot reuse the leader PID while any member of the old group remains.
  if (owner.anchorBornUtc && current && current.born !== owner.anchorBornUtc) return true;
  const { stdout } = await exec('ps', ['-axo', 'pgid=', '-o', 'stat='], { timeout: 2000, maxBuffer: 4 * 1024 * 1024 });
  const rows = stdout
    .trim()
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\S+)/.exec(line));
  if (rows.some((row) => !row)) throw new Error('Invalid daemon group observation.');
  return !rows.some((row) => Number(row![1]) === identity.pid && !row![2]!.startsWith('Z'));
}
export async function runPosixGuardian(options: DaemonLaunchOptions, generation: string): Promise<void> {
  const inventory = await processInventory([process.pid]);
  const identity = inventory.processes.find((item) => item.pid === process.pid);
  const { stdout } = await exec('ps', ['-p', String(process.pid), '-o', 'pgid='], { timeout: 2000 });
  if (!identity?.born || identity.owner !== inventory.owner || Number(stdout.trim()) !== process.pid)
    throw new Error('Daemon guardian requires its own process group.');
  const anchor = await posixAnchor(process.pid);
  if (!anchor || anchor.pgid !== process.pid || anchor.owner !== inventory.owner)
    throw new Error('Unverified daemon anchor.');
  const endpoint = guardSocketPath(generation);
  const key = await daemonKey();
  await updateOwner(generation, {
    identity: { ...identity, owner: identity.owner, born: identity.born },
    guardSocket: endpoint,
    anchorBornUtc: anchor.born,
  });
  if ((await readLifecycle()).active?.phase !== 'starting') throw new Error('Daemon launch reservation expired.');
  let retiring = false;
  const retire = () => {
    if (retiring) return;
    retiring = true;
    // Signal our own anchored group, never a PID or PGID recovered from a file.
    process.kill(0, 'SIGTERM');
    setTimeout(() => process.kill(0, 'SIGKILL'), 1000);
  };
  process.on('SIGTERM', retire);
  process.on('SIGINT', retire);
  const server = net.createServer((socket) => {
    const frames = new SocketFrames(socket);
    socket.setTimeout(1500, () => socket.destroy());
    void (async () => {
      await authenticateServer(frames, key);
      const request = (await frames.read()) as DaemonRequest;
      if (
        request.protocolVersion !== DAEMON_PROTOCOL_VERSION ||
        request.generation !== generation ||
        (request.method !== 'stop' && request.method !== 'status')
      )
        throw new Error('Invalid guardian request.');
      frames.write({ id: request.id, ok: true, result: { role: 'guardian', generation } });
      socket.end();
      if (request.method === 'stop') setImmediate(retire);
    })().catch(() => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, resolve);
  });
  await fs.chmod(endpoint, 0o600);
  const launch = buildDaemonLaunchInvocation(options);
  const args = launch.command === 'nohup' ? launch.args.slice(1) : launch.args;
  const worker = spawn(process.execPath, args, {
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    env: { ...launch.env, MCPORTER_DAEMON_WORKER: '1', MCPORTER_DAEMON_GENERATION: generation },
  });
  worker.once('error', retire);
  worker.once('exit', retire);
  await once(worker, 'exit');
}
export async function prepareManagedWorker(generation: string): Promise<void> {
  const state = await readLifecycle();
  if (state.active?.generation !== generation || state.active.phase !== 'starting')
    throw new Error('Daemon launch reservation expired.');
  if (process.platform === 'win32') {
    process.env.MCPORTER_DAEMON_WORKER = '1';
    const jobName = `Global\\MCPorter-${generation}`;
    const inventory = await processInventory([process.pid]);
    const identity = inventory.processes.find((item) => item.pid === process.pid);
    if (!identity?.born || identity.owner !== inventory.owner)
      throw new Error('Daemon ownership could not be verified.');
    await updateOwner(generation, { identity: { ...identity, owner: identity.owner, born: identity.born }, jobName });
    await attachWindowsJob(generation);
  } else {
    if (!state.active.identity || process.ppid !== state.active.identity.pid || !process.channel)
      throw new Error('Daemon worker has no verified guardian.');
    process.on('disconnect', () => process.kill(0, 'SIGKILL'));
    process.channel.unref();
  }
}
