import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export interface BootIdentity {
  readonly platform: 'linux' | 'darwin';
  readonly id: string;
}

export function isBootIdentity(value: unknown): value is BootIdentity {
  if (!value || typeof value !== 'object') return false;
  const identity = value as BootIdentity;
  return (
    (identity.platform === 'linux' || identity.platform === 'darwin') &&
    typeof identity.id === 'string' &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(identity.id)
  );
}

/** Kernel boot UUIDs survive sleep, but not a reboot; wall clocks and PID absence are not boot evidence. */
export async function readBootIdentity(): Promise<BootIdentity | undefined> {
  try {
    let value: string;
    if (process.platform === 'linux') value = await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8');
    else if (process.platform === 'darwin') {
      ({ stdout: value } = await exec('/usr/sbin/sysctl', ['-n', 'kern.bootsessionuuid'], {
        timeout: 5000,
        maxBuffer: 1024,
        encoding: 'utf8',
      }));
    } else return undefined;
    const identity = { platform: process.platform, id: value.trim().toLowerCase() };
    return isBootIdentity(identity) ? identity : undefined;
  } catch {
    // Normal startup remains available; recovery fails closed without kernel evidence.
    return undefined;
  }
}
