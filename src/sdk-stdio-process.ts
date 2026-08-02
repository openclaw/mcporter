import type { ChildProcess } from 'node:child_process';
import { waitForChildExit } from './process-utils.js';

export type MaybeChildProcess = ChildProcess & { stdio?: Array<unknown> };

function ignoreEmitterError(): void {}

export function destroyStream(stream: unknown): void {
  if (!stream || typeof stream !== 'object') return;
  const emitter = stream as {
    on?: (event: string, listener: () => void) => void;
    off?: (event: string, listener: () => void) => void;
    removeListener?: (event: string, listener: () => void) => void;
    destroy?: () => void;
    end?: () => void;
    unref?: () => void;
  };
  try {
    emitter.on?.('error', ignoreEmitterError);
  } catch {}
  try {
    emitter.destroy?.();
  } catch {}
  try {
    emitter.end?.();
  } catch {}
  try {
    emitter.unref?.();
  } catch {}
  try {
    emitter.off?.('error', ignoreEmitterError);
  } catch {}
  try {
    emitter.removeListener?.('error', ignoreEmitterError);
  } catch {}
}

function destroyChildStreams(child: MaybeChildProcess): void {
  destroyStream(child.stdin);
  destroyStream(child.stdout);
  destroyStream(child.stderr);
  for (const stream of Array.isArray(child.stdio) ? child.stdio : []) destroyStream(stream);
}

export async function closeStdioChild(child: MaybeChildProcess): Promise<void> {
  destroyChildStreams(child);
  let exited = await waitForChildExit(child, 700).then(
    () => true,
    () => false
  );
  if (!exited) {
    try {
      child.kill('SIGTERM');
    } catch {}
    exited = await waitForChildExit(child, 700).then(
      () => true,
      () => false
    );
  }
  if (!exited) {
    try {
      child.kill('SIGKILL');
    } catch {}
    await waitForChildExit(child, 500).catch(() => {});
  }
  destroyChildStreams(child);
  child.unref?.();
}
