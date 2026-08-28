import type { ChildProcess } from 'node:child_process';
import { waitForChildExit } from '../../src/process-utils.js';
import { budget } from './timing.js';

export async function closeFixtureResources(
  proxy: { close(): Promise<void> } | undefined,
  children: ReadonlySet<ChildProcess>
): Promise<void> {
  // A proxy can fail to close or wait for an upstream child to exit.
  const stoppedChildren = Promise.allSettled([...children].map((child) => stopFixtureChild(child)));
  try {
    await proxy?.close();
  } finally {
    await stoppedChildren;
  }
}

export async function stopFixtureChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  try {
    await waitForChildExit(child, budget(2_000));
  } catch {
    child.kill('SIGKILL');
    await waitForChildExit(child, budget(2_000)).catch(() => {});
  }
}
