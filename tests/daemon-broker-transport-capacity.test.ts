import { SdkErrorCode } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { DaemonBroker } from '../src/daemon/broker.js';
import { effectiveDefinition } from '../src/daemon/connection-identity.js';

// Fake runtimes: the broker's pooling and capacity logic is under test, not MCP transport I/O.
interface FakeRuntime {
  close: ReturnType<typeof vi.fn>;
  call: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
}
let connectFails = false;
const runtimes: FakeRuntime[] = [];
vi.mock('../src/runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/runtime.js')>()),
  createRuntime: vi.fn(async () => {
    const runtime: FakeRuntime = {
      close: vi.fn(async () => {}),
      call: vi.fn(async () => ({ content: [] })),
      connect: vi.fn(async () => {
        if (connectFails) throw new Error('server unreachable');
        return { client: { getServerVersion: () => undefined }, transport: {} };
      }),
    };
    runtimes.push(runtime);
    return {
      connect: runtime.connect,
      callTool: runtime.call,
      close: runtime.close,
    };
  }),
}));

const remote: ServerDefinition = {
  name: 'remote',
  command: { kind: 'http', url: new URL('https://mcp.example.test/mcp') },
  lifecycle: { mode: 'keep-alive' },
};

/** One caller session: the same configured server, resolved from that session's own environment. */
async function session(broker: DaemonBroker, id: number, server: ServerDefinition = remote) {
  const definition = await effectiveDefinition(server, { PATH: process.env.PATH, CALLER_SESSION_ID: `session-${id}` });
  // Registration crosses the daemon socket as JSON, exactly like DaemonClient's registerView.
  const handle = broker.register(JSON.parse(JSON.stringify({ definitions: [definition] })));
  return () =>
    broker.invoke({
      id: `call-${id}`,
      method: 'callTool',
      params: { server: 'remote', tool: 'ping', args: {} },
      ...handle,
    });
}

/** Fills the broker with `count` connected transports, one per caller environment. */
async function fill(broker: DaemonBroker, count = 256) {
  const calls = [];
  for (let id = 0; id < count; id++) {
    const call = await session(broker, id);
    await call();
    calls.push(call);
  }
  return calls;
}

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((res, rej) => ((resolve = res), (reject = rej)));
  promise.catch(() => {});
  return { promise, resolve, reject };
}

const closed = (index: number) => runtimes[index]!.close.mock.calls.length;
const closedIndexes = () => runtimes.flatMap((runtime, index) => (runtime.close.mock.calls.length ? [index] : []));

afterEach(() => {
  runtimes.length = 0;
  connectFails = false;
  vi.useRealTimers();
});

describe('daemon broker transport capacity', () => {
  it('reclaims the least recently used unused transport instead of refusing a new caller', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const broker = new DaemonBroker();
    try {
      const calls = await fill(broker);
      vi.setSystemTime(Date.now() + 1_000);
      await calls[0]!(); // used again later, so the transport of caller 1 is now the least recently used

      await expect((await session(broker, 256))()).resolves.toEqual({ content: [] });

      expect(closedIndexes()).toEqual([1]);
      expect(broker.status().servers).toHaveLength(256);
    } finally {
      await broker.close();
    }
  });

  it('reclaims an already idle-retired transport before retiring a connected one', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const broker = new DaemonBroker();
    try {
      await fill(broker, 255);
      const shortIdle: ServerDefinition = { ...remote, lifecycle: { mode: 'keep-alive', idleTimeoutMs: 1_000 } };
      await (
        await session(broker, 255, shortIdle)
      )();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(closedIndexes()).toEqual([255]);

      await expect((await session(broker, 256))()).resolves.toEqual({ content: [] });

      expect(closedIndexes()).toEqual([255]);
      expect(broker.status().servers).toHaveLength(256);
    } finally {
      await broker.close();
    }
  });

  it('never reclaims a transport with a call in flight', async () => {
    const broker = new DaemonBroker();
    const hold = deferred();
    const pending: Promise<unknown>[] = [];
    try {
      for (const [id, call] of (await fill(broker)).entries()) {
        runtimes[id]!.call.mockImplementationOnce(async () => (await hold.promise, { content: [] }));
        pending.push(call());
      }
      await vi.waitFor(() => expect(runtimes.every((runtime) => runtime.call.mock.calls.length === 2)).toBe(true));

      await expect((await session(broker, 256))()).rejects.toMatchObject({
        code: 'transport_limit',
        message: expect.stringContaining('Retry after active calls finish'),
      });
      expect(closedIndexes()).toEqual([]);
    } finally {
      hold.resolve();
      await Promise.all(pending);
      await broker.close();
    }
  });

  it('admits two concurrent callers with the same new identity once a slot is free', async () => {
    const broker = new DaemonBroker();
    const hold = deferred();
    const pending: Promise<unknown>[] = [];
    try {
      const calls = await fill(broker);
      for (const [id, call] of calls.slice(0, 255).entries()) {
        runtimes[id]!.call.mockImplementationOnce(async () => (await hold.promise, { content: [] }));
        pending.push(call());
      }

      const [first, second] = [(await session(broker, 300))(), (await session(broker, 300))()];

      await expect(Promise.all([first, second])).resolves.toEqual([{ content: [] }, { content: [] }]);
      expect(closedIndexes()).toEqual([255]);
      expect(broker.status().servers).toHaveLength(256);
    } finally {
      hold.resolve();
      await Promise.all(pending);
      await broker.close();
    }
  });

  it('retires only one transport for several concurrent callers with the same new identity', async () => {
    const broker = new DaemonBroker();
    try {
      await fill(broker);
      const callers = await Promise.all([300, 300, 300, 300].map((id) => session(broker, id)));

      await expect(Promise.all(callers.map((call) => call()))).resolves.toEqual(
        Array.from({ length: 4 }, () => ({ content: [] }))
      );

      expect(closedIndexes()).toEqual([0]);
      expect(broker.status().servers).toHaveLength(256);
    } finally {
      await broker.close();
    }
  });

  it('keeps a transport that a caller rejoins while it is being reclaimed', async () => {
    const broker = new DaemonBroker();
    const closing = deferred();
    try {
      const calls = await fill(broker);
      runtimes[0]!.close.mockImplementationOnce(() => closing.promise);

      const newcomer = (await session(broker, 256))();
      await Promise.race([vi.waitFor(() => expect(closed(0)).toBe(1)), newcomer]);
      const rejoin = calls[0]!();
      closing.resolve();

      await expect(rejoin).resolves.toEqual({ content: [] });
      await expect(newcomer).resolves.toEqual({ content: [] });
      expect(closedIndexes()).toEqual([0, 1]);
      expect(broker.status().servers).toHaveLength(256);
    } finally {
      closing.resolve();
      await broker.close();
    }
  });

  it('keeps a failed retirement tracked, also for a second reclaimer, and moves on', async () => {
    const broker = new DaemonBroker();
    const closing = deferred();
    try {
      await fill(broker);
      runtimes[0]!.close.mockImplementationOnce(() => closing.promise);

      const first = (await session(broker, 256))();
      const second = (await session(broker, 257))();
      first.catch(() => {});
      second.catch(() => {});
      await vi.waitFor(() => expect(closed(0)).toBe(1));
      closing.reject(new Error('retirement unverified'));

      await expect(Promise.all([first, second])).resolves.toEqual([{ content: [] }, { content: [] }]);
      expect(closed(0)).toBe(1); // the second reclaimer did not retry the failed retirement
      expect(closedIndexes()).toEqual([0, 1, 2]);
      expect(broker.status().servers).toHaveLength(256);
      // Like a failed idle retirement, it stays visible and blocks a clean stop.
      await expect(broker.close()).rejects.toMatchObject({ code: 'transport_retirement_failed' });
    } finally {
      closing.resolve();
      await broker.close().catch(() => {});
    }
  });

  it('skips a candidate whose call ended with an unknown outcome while reclaim was waiting', async () => {
    const broker = new DaemonBroker();
    const closing = deferred();
    try {
      const calls = await fill(broker);
      runtimes[0]!.close.mockImplementationOnce(() => closing.promise);
      runtimes[1]!.call.mockRejectedValueOnce(
        Object.assign(new Error('timed out'), { code: SdkErrorCode.RequestTimeout })
      );

      const newcomer = (await session(broker, 256))();
      newcomer.catch(() => {});
      await vi.waitFor(() => expect(closed(0)).toBe(1));
      await expect(calls[1]!()).rejects.toMatchObject({ code: 'operation_timeout' });
      closing.reject(new Error('retirement unverified'));

      await expect(newcomer).resolves.toEqual({ content: [] });
      expect(closedIndexes()).toEqual([0, 2]); // unknown outcome: caller 1's transport is kept
    } finally {
      closing.resolve();
      await broker.close().catch(() => {});
    }
  });

  it('reclaims a failed connect before a connected transport', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const broker = new DaemonBroker();
    try {
      await fill(broker, 255);
      vi.setSystemTime(Date.now() + 1_000); // the failed connect below is the most recently used entry
      connectFails = true;
      await expect((await session(broker, 255))()).rejects.toThrow('server unreachable');
      connectFails = false;

      await expect((await session(broker, 256))()).resolves.toEqual({ content: [] });

      expect(closedIndexes()).toEqual([255]);
      expect(broker.status().servers).toHaveLength(256);
    } finally {
      await broker.close();
    }
  });

  it('reclaims transports left behind by connects that failed', async () => {
    const broker = new DaemonBroker();
    try {
      connectFails = true;
      for (let id = 0; id < 256; id++)
        await expect((await session(broker, id))()).rejects.toThrow('server unreachable');
      expect(broker.status().servers).toHaveLength(256);
      connectFails = false;

      await expect((await session(broker, 256))()).resolves.toEqual({ content: [] });

      expect(closedIndexes()).toEqual([0]);
      expect(broker.status().servers).toHaveLength(256);
    } finally {
      await broker.close();
    }
  });
});
