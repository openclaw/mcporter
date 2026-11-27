import { createHash } from 'node:crypto';
import { daemonRunDir } from './paths.js';
import { writeJsonFile } from '../fs-json.js';
import { jobProofPath, isGeneration } from './lifecycle-state.js';
export function windowsJobName(generation: string): string {
  if (!isGeneration(generation)) throw new Error('Invalid daemon generation.');
  return `Global\\MCPorter-${createHash('sha256').update(daemonRunDir().toLowerCase()).digest('hex').slice(0, 16)}-${generation}`;
}
let jobHandle: bigint | null = null;
export async function attachWindowsJob(generation: string): Promise<string> {
  if (!isGeneration(generation) || jobHandle) throw new Error('Invalid or repeated daemon Job setup.');
  const name = windowsJobName(generation);
  const { createWindowsJob } = await import('./win32-native.js');
  jobHandle = createWindowsJob(name);
  // Keep the sole non-inherited handle in this host. OS exit closes it even after SIGKILL.
  await writeJsonFile(jobProofPath(generation), { generation, name, pid: process.pid });
  return name;
}
export async function inspectWindowsJob(name: string, terminate = false): Promise<number> {
  if (!/^Global\\MCPorter-(?:[a-f0-9]{16}-)?[a-f0-9-]{36}$/.test(name)) throw new Error('Invalid daemon Job name.');
  const { inspectNativeWindowsJob } = await import('./win32-native.js');
  return inspectNativeWindowsJob(name, terminate);
}
