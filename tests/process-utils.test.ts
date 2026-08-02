import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isProcessRunning, waitForChildExit } from '../src/process-utils.js';

describe('process utilities', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects invalid process identifiers and recognizes the current process', () => {
    expect(isProcessRunning(0)).toBe(false);
    expect(isProcessRunning(-1)).toBe(false);
    expect(isProcessRunning(process.pid)).toBe(true);
  });

  it('resolves child exit events and removes its listeners', async () => {
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { exitCode: null });
    const wait = waitForChildExit(child, 1_000);

    child.emit('exit', 0, null);

    await expect(wait).resolves.toBeUndefined();
    expect(child.listenerCount('exit')).toBe(0);
    expect(child.listenerCount('close')).toBe(0);
    expect(child.listenerCount('error')).toBe(0);
  });

  it('rejects when the child misses its deadline', async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as ChildProcess;
    Object.assign(child, { exitCode: null });
    const wait = waitForChildExit(child, 100);
    const assertion = expect(wait).rejects.toThrow('Timed out waiting 100ms');

    await vi.advanceTimersByTimeAsync(100);

    await assertion;
  });
});
