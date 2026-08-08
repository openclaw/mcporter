import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogContext, disposeLogContext, logEvent } from '../src/daemon/log-context.js';

describe('daemon log context stream safety', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      tempDir = undefined;
    }
  });

  it('attaches an error listener when opening the daemon log WriteStream', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-log-context-'));
    const logPath = path.join(tempDir, 'daemon.log');
    const context = createLogContext({
      enabled: true,
      logAllServers: true,
      servers: new Set(),
      logPath,
    });

    try {
      expect(context.writer).toBeDefined();
      // Without an early error listener, ENOSPC / EIO on the long-lived stream
      // becomes an uncaughtException and takes down the daemon.
      expect(context.writer!.listenerCount('error')).toBeGreaterThan(0);
    } finally {
      await disposeLogContext(context);
    }
  });

  it('handles log stream errors directly and stops writing', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-log-context-'));
    const logPath = path.join(tempDir, 'daemon.log');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const context = createLogContext({
      enabled: true,
      logAllServers: true,
      servers: new Set(),
      logPath,
    });
    expect(context.writer).toBeDefined();
    const writer = context.writer!;

    try {
      const streamError = Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      expect(() => writer.emit('error', streamError)).not.toThrow();

      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no space left on device'));
      expect(context.writer).toBeUndefined();

      // logEvent must not throw after the stream is dropped.
      expect(() => logEvent(context, 'after stream failure')).not.toThrow();
    } finally {
      await destroyWriter(writer);
      await disposeLogContext(context);
    }
  });
});

async function destroyWriter(writer: import('node:fs').WriteStream): Promise<void> {
  if (writer.closed) {
    return;
  }
  await new Promise<void>((resolve) => {
    writer.once('close', resolve);
    writer.destroy();
  });
}
