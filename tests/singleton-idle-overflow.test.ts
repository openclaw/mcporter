import { afterEach, expect, it, vi } from 'vitest';
import { DaemonBroker } from '../src/daemon/broker.js';
import { BrowserOwner } from '../src/daemon/browser-owner.js';
import { MAX_NATIVE_TIMER_MS } from '../src/daemon/idle-timer.js';
import { createRuntime } from '../src/runtime.js';
import { SdkErrorCode } from '@modelcontextprotocol/client';

vi.mock('../src/runtime.js', () => ({ createRuntime: vi.fn() }));
const month = 30 * 24 * 60 * 60 * 1000;
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function fixture(chrome = false) {
  const close = vi.fn(async () => {});
  const callTool = vi.fn(async () => 'ok');
  vi.mocked(createRuntime).mockResolvedValue({
    connect: async () => ({ transport: {}, client: {} }),
    callTool,
    close,
  } as unknown as Awaited<ReturnType<typeof createRuntime>>);
  const broker = new DaemonBroker();
  const handle = broker.register({
    definitions: [
      {
        name: 'fixture',
        command: {
          kind: 'stdio',
          command: chrome ? 'chrome-devtools-mcp' : process.execPath,
          args: [],
          cwd: process.cwd(),
        },
        lifecycle: { mode: 'keep-alive', idleTimeoutMs: month },
      },
    ],
  });
  const invoke = () =>
    broker.invoke({ id: 'call', method: 'callTool', params: { server: 'fixture', tool: 'identity' }, ...handle });
  return { broker, close, callTool, invoke };
}

it('slices broker idle deadlines at native max, retires only at full expiry, and extends on activity', async () => {
  vi.useFakeTimers();
  const timers = vi.spyOn(globalThis, 'setTimeout');
  const f = fixture();
  try {
    await f.invoke();
    await vi.advanceTimersByTimeAsync(MAX_NATIVE_TIMER_MS);
    expect(f.close).not.toHaveBeenCalled();
    expect(f.broker.status().servers[0]?.connected).toBe(true);
    // A fresh view is needed after 15 minutes of inactivity; transport lifetime is independent.
    const handle = f.broker.register({
      definitions: [
        {
          name: 'fixture',
          command: { kind: 'stdio', command: process.execPath, args: [], cwd: process.cwd() },
          lifecycle: { mode: 'keep-alive', idleTimeoutMs: month },
        },
      ],
    });
    await f.broker.invoke({
      id: 'activity',
      method: 'callTool',
      params: { server: 'fixture', tool: 'identity' },
      ...handle,
    });
    await vi.advanceTimersByTimeAsync(month - MAX_NATIVE_TIMER_MS);
    expect(f.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MAX_NATIVE_TIMER_MS - 1);
    expect(f.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.close).toHaveBeenCalledTimes(1);
    expect(f.broker.status().servers[0]?.connected).toBe(false);
    expect(timers.mock.calls.every(([, delay]) => delay! > 0 && delay! <= MAX_NATIVE_TIMER_MS)).toBe(true);
  } finally {
    await f.broker.close();
  }
});

it('does not schedule retirement or busy-loop while active/queued or after an unknown outcome', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const held = Promise.withResolvers<string>();
  f.callTool.mockReturnValueOnce(held.promise);
  const first = f.invoke();
  const second = f.invoke();
  try {
    await vi.advanceTimersByTimeAsync(month * 2);
    expect(f.broker.status().servers[0]?.activeCalls).toBe(2);
    expect(f.close).not.toHaveBeenCalled();
    expect(f.broker.canIdleShutdown()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    held.resolve('done');
    await Promise.all([first, second]);
    f.callTool.mockRejectedValueOnce(
      Object.assign(new Error('synthetic timeout'), { code: SdkErrorCode.RequestTimeout })
    );
    await expect(f.invoke()).rejects.toMatchObject({ code: 'operation_timeout' });
    await vi.advanceTimersByTimeAsync(month * 2);
    expect(f.close).not.toHaveBeenCalled();
    expect(f.broker.canIdleShutdown()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    held.resolve('cleanup');
    await Promise.allSettled([first, second]);
    await f.broker.close();
  }
});

it('keeps a Chrome entry timer-free across arbitrarily long idle gaps', async () => {
  vi.useFakeTimers();
  // Synthetic ownership only; no real credential discovery, transport or browser is used.
  vi.spyOn(BrowserOwner.prototype, 'reserve').mockImplementation((definition) => definition);
  vi.spyOn(BrowserOwner.prototype, 'resolveIdentity').mockResolvedValue('synthetic-authority');
  const f = fixture(true);
  try {
    await f.invoke();
    await vi.advanceTimersByTimeAsync(month * 3);
    expect(f.close).not.toHaveBeenCalled();
    expect(f.broker.status().servers[0]?.idleBlocked).toBe('browser-owner');
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await f.broker.close();
  }
});
