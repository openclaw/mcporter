import { expect, describe, it } from 'vitest';
import {
  DaemonFrameDecoder,
  encodeDaemonFrame,
  resolveProgressInterval,
  resolveProgressTiming,
} from '../src/daemon/protocol.js';
import { singletonFixture } from './helpers/singleton.js';
describe('daemon frame protocol', () => {
  it('maps raw progress requests to fixed protocol-owned cadences', () => {
    expect([1, 49, 50, 99, 100, 249, 250, Number.MAX_SAFE_INTEGER].map(resolveProgressInterval)).toEqual([
      25, 25, 50, 50, 100, 100, 250, 250,
    ]);
  });

  it('bounds progress frequency for short and long idle budgets', () => {
    expect(resolveProgressTiming(1)).toEqual({ progressIntervalMs: 25, idleTimeoutMs: 100 });
    expect(resolveProgressTiming(60)).toEqual({ progressIntervalMs: 25, idleTimeoutMs: 100 });
    expect(resolveProgressTiming(900)).toEqual({ progressIntervalMs: 250, idleTimeoutMs: 900 });
    expect(resolveProgressTiming(Number.MAX_SAFE_INTEGER)).toEqual({
      progressIntervalMs: 250,
      idleTimeoutMs: 2_147_483_647,
    });
  });

  it('decodes split and coalesced frames and reports malformed lines', () => {
    const decoder = new DaemonFrameDecoder();
    const progress = encodeDaemonFrame({ type: 'progress', id: 'one' });
    const response = encodeDaemonFrame({ id: 'one', ok: true, result: ['done'] });

    expect(decoder.push(progress.slice(0, 8))).toEqual([]);
    expect(decoder.push(`${progress.slice(8)}not-json\n${response.slice(0, -1)}`)).toEqual([
      { type: 'progress', id: 'one' },
    ]);
    expect(decoder.flush()).toEqual([{ id: 'one', ok: true, result: ['done'] }]);
    expect(decoder.malformed).toBe(true);
  });
});

it('keeps authenticated requests alive with bounded progress and refuses stop during active work', async () => {
  const f = await singletonFixture();
  try {
    const c = f.client();
    await c.listTools({ server: 'fixture' });
    const flight = c.callTool({ server: 'fixture', tool: 'delayed', timeoutMs: 1000 });
    for (let i = 0; i < 100 && !f.host.status().servers.some((s) => (s.activeCalls ?? 0) > 0); i++)
      await new Promise((r) => setTimeout(r, 5));
    await expect(c.stop()).rejects.toMatchObject({ code: 'active_calls' });
    await flight;
    await c.stop();
  } finally {
    await f.close();
  }
});
