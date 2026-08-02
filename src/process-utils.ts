import type { ChildProcess } from 'node:child_process';

function ignoreEmitterError(): void {}

export function isProcessRunning(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function waitForChildExit(child: ChildProcess | undefined, timeoutMs: number): Promise<void> {
  if (!child || (child.exitCode !== null && child.exitCode !== undefined)) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    child.on('error', ignoreEmitterError);
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };
    const timeout = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error(`Timed out waiting ${timeoutMs}ms for child process to close.`));
    };
    const cleanup = (): void => {
      child.removeListener('exit', finish);
      child.removeListener('close', finish);
      child.removeListener('error', finish);
      child.removeListener('error', ignoreEmitterError);
      if (timer) {
        clearTimeout(timer);
      }
    };
    child.once('exit', finish);
    child.once('close', finish);
    child.once('error', finish);
    let timer: NodeJS.Timeout | undefined;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(timeout, timeoutMs);
      timer.unref?.();
    }
  });
}
