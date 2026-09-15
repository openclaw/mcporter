import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Transport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecordTransport } from '../src/runtime/record-transport.js';

const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

async function setup() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-record-errors-'));
  directories.push(directory);
  const inner = {
    onclose: undefined as Transport['onclose'],
    onmessage: undefined as Transport['onmessage'],
    start: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  } satisfies Transport;
  const transport = new RecordTransport({ inner, recordPath: path.join(directory, 'session.ndjson'), server: 'demo' });
  await transport.start();
  return { inner, transport };
}

describe('recording write failures', () => {
  it('closes the underlying transport even when recording a send fails', async () => {
    const { inner, transport } = await setup();
    const failure = new Error('synthetic disk full');
    vi.spyOn(fs, 'appendFile').mockRejectedValue(failure);

    await expect(transport.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).rejects.toThrow(failure);
    expect(inner.send).not.toHaveBeenCalled();
    await expect(transport.close()).rejects.toThrow(failure);
    expect(inner.close).toHaveBeenCalledOnce();
  });

  it('reports incoming write failures once without unhandled rejections and still closes', async () => {
    const { inner, transport } = await setup();
    const failure = new Error('synthetic disk full');
    vi.spyOn(fs, 'appendFile').mockRejectedValue(failure);
    transport.onerror = vi.fn();
    transport.onmessage = vi.fn();
    const message = { jsonrpc: '2.0' as const, id: 1, result: {} };

    inner.onmessage?.(message);
    inner.onmessage?.(message);

    await vi.waitFor(() => expect(transport.onerror).toHaveBeenCalledExactlyOnceWith(failure));
    expect(transport.onmessage).toHaveBeenCalledTimes(2);
    await expect(transport.close()).rejects.toThrow(failure);
    expect(inner.close).toHaveBeenCalledOnce();
    expect(transport.onerror).toHaveBeenCalledOnce();
  });

  it('reports a failed close-event write and preserves the failure for explicit close', async () => {
    const { inner, transport } = await setup();
    const failure = new Error('synthetic disk full');
    vi.spyOn(fs, 'appendFile').mockRejectedValue(failure);
    transport.onerror = vi.fn();
    transport.onclose = vi.fn();

    inner.onclose?.();
    inner.onclose?.();

    await vi.waitFor(() => expect(transport.onerror).toHaveBeenCalledExactlyOnceWith(failure));
    expect(transport.onclose).toHaveBeenCalledTimes(2);
    await expect(transport.close()).rejects.toThrow(failure);
    expect(inner.close).toHaveBeenCalledOnce();
  });

  it('drains writes even when the underlying close rejects', async () => {
    const { inner, transport } = await setup();
    const failure = new Error('synthetic transport close failure');
    vi.mocked(inner.close).mockImplementation(async () => {
      inner.onmessage?.({ jsonrpc: '2.0', method: 'notifications/test' });
      throw failure;
    });
    const append = vi.spyOn(fs, 'appendFile');

    await expect(transport.close()).rejects.toThrow(failure);
    expect(append).toHaveBeenCalledTimes(2);
    expect(inner.close).toHaveBeenCalledOnce();
  });
});
