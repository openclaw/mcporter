import { retireService, verifyWorkerService } from './service-manager.js';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { processInventory } from './process-retirement.js';
import { readLifecycle, updateOwner, jobProofPath, type ManagedOwner } from './lifecycle-state.js';
import { attachWindowsJob, inspectWindowsJob, windowsJobName } from './windows-job.js';

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
  if (!owner.service && owner.cleanExit && owner.identity) {
    const deadline = Date.now() + 5000;
    while (true) {
      const inventory = await processInventory([owner.identity.pid]);
      const current = inventory.processes.find((row) => row.pid === owner.identity!.pid);
      if (current && current.born !== owner.identity.born) return;
      const { stdout } = await exec('ps', ['-axo', 'pgid=', '-o', 'stat='], { timeout: 2000 });
      const alive = stdout
        .trim()
        .split('\n')
        .some((line) => {
          const match = /^\s*(\d+)\s+(\S+)/.exec(line);
          if (!match) throw new Error('Invalid legacy group observation.');
          return Number(match[1]) === owner.identity!.pid && !match[2]!.startsWith('Z');
        });
      if (!alive) return;
      if (Date.now() >= deadline) throw new Error('Legacy daemon has not finished its clean shutdown.');
      await pause(50);
    }
  }
  if (!owner.service)
    throw new Error('Legacy guardian generation must be stopped with its original CLI before upgrading.');
  await retireService(owner);
}
export async function prepareManagedWorker(generation: string): Promise<void> {
  const state = await readLifecycle();
  if (state.active?.generation !== generation || state.active.phase !== 'starting')
    throw new Error('Daemon launch reservation expired.');
  if (process.platform === 'win32') {
    process.env.MCPORTER_DAEMON_WORKER = '1';
    const jobName = windowsJobName(generation);
    const inventory = await processInventory([process.pid]);
    const identity = inventory.processes.find((item) => item.pid === process.pid);
    if (!identity?.born || identity.owner !== inventory.owner)
      throw new Error('Daemon ownership could not be verified.');
    await updateOwner(generation, { identity: { ...identity, owner: identity.owner, born: identity.born }, jobName });
    await attachWindowsJob(generation);
  } else {
    if (!state.active.service) throw new Error('Daemon has no reserved OS service.');
    await verifyWorkerService(state.active);
    const inventory = await processInventory([process.pid]);
    const identity = inventory.processes.find((item) => item.pid === process.pid);
    if (!identity?.born || identity.owner !== inventory.owner)
      throw new Error('Daemon ownership could not be verified.');
    const { stdout } = await exec('ps', ['-p', String(process.pid), '-o', 'pgid='], { timeout: 2000 });
    if (Number(stdout.trim()) !== process.pid) throw new Error('Daemon service has no private process group.');
    const darwinOwnership =
      process.platform === 'darwin' ? (await import('./darwin-native.js')).darwinOwnership() : undefined;
    await updateOwner(generation, {
      identity: { ...identity, owner: identity.owner, born: identity.born },
      ...(darwinOwnership ? { darwinOwnership } : {}),
    });
  }
}
