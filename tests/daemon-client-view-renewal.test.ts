import { expect, it, vi } from 'vitest';
import { DaemonBroker, BrokerError } from '../src/daemon/broker.js';
import * as rpc from '../src/daemon/socket-rpc.js';
import { singletonFixture, fixtureResult } from './helpers/singleton.js';

function gate() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, open: () => resolve() };
}

it('renews after a real expiry sweep and executes each concurrent counter operation exactly once', async () => {
  const f = await singletonFixture();
  const actual = rpc.requestDaemon;
  const expired = gate();
  let rejected = 0;
  const spy = vi.spyOn(rpc, 'requestDaemon').mockImplementation(async (...args) => {
    const response = await actual(...args);
    if (args[1].method === 'callTool' && response.error?.retry === 'renew_view') {
      if (++rejected === 3) expired.open();
      await expired.promise;
    }
    return response;
  });
  const now = Date.now();
  let clock: { mockRestore(): void } | undefined;
  try {
    const client = f.client();
    client.setDefinitions([f.definition], { name: 'preserved-client', version: '7' });
    const first = fixtureResult(await client.callTool({ server: 'fixture', tool: 'identity' }));
    clock = vi.spyOn(Date, 'now').mockReturnValue(now + 16 * 60_000);
    expect(f.host.status().views).toBe(0);
    const results = await Promise.all(
      Array.from({ length: 3 }, () => client.callTool({ server: 'fixture', tool: 'identity' }))
    );
    expect(rejected).toBe(3);
    expect(results.map((value) => fixtureResult(value).count).toSorted((a, b) => a - b)).toEqual([2, 3, 4]);
    expect(results.map((value) => fixtureResult(value).id)).toEqual([first.id, first.id, first.id]);
    const registrations = spy.mock.calls.filter(([, request]) => request.method === 'registerView');
    expect(registrations).toHaveLength(2);
    expect(registrations[1]?.[1].params).toEqual(registrations[0]?.[1].params);
    expect(f.host.status().views).toBe(1);
    await client.release();
    expect(f.host.status().views).toBe(0);
  } finally {
    expired.open();
    clock?.mockRestore();
    spy.mockRestore();
    await f.close();
  }
});

it('stops after one renewal if the broker expires the replacement too', async () => {
  const f = await singletonFixture();
  const actual = rpc.requestDaemon;
  let now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
  const spy = vi.spyOn(rpc, 'requestDaemon').mockImplementation(async (...args) => {
    if (args[1].method === 'callTool') {
      now += 16 * 60_000;
      f.host.status();
    }
    return actual(...args);
  });
  try {
    const client = f.client();
    await expect(client.callTool({ server: 'fixture', tool: 'identity' })).rejects.toMatchObject({
      code: 'view_expired',
    });
    expect(spy.mock.calls.filter(([, request]) => request.method === 'registerView')).toHaveLength(2);
    expect(spy.mock.calls.filter(([, request]) => request.method === 'callTool')).toHaveLength(2);
    await client.release();
    expect(f.host.status().views).toBe(0);
    expect(f.host.status().servers).toEqual([]);
  } finally {
    clock.mockRestore();
    spy.mockRestore();
    await f.close();
  }
});

for (const code of ['view_expired', 'daemon_generation_changed', 'operation_timeout', 'ECONNRESET'])
  it(`does not replay an unmarked ${code} error, even with spoofed retry properties`, async () => {
    const f = await singletonFixture();
    // Simulate an operation-layer failure at the broker/host boundary: only the
    // dedicated admission error type may acquire the wire retry marker.
    const invoke = vi
      .spyOn(DaemonBroker.prototype, 'invoke')
      .mockRejectedValue(Object.assign(new BrokerError(code, 'downstream failure'), { retry: 'renew_view' }));
    const spy = vi.spyOn(rpc, 'requestDaemon');
    try {
      const client = f.client();
      await expect(client.callTool({ server: 'fixture', tool: 'identity' })).rejects.toMatchObject({ code });
      expect(invoke).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls.filter(([, request]) => request.method === 'registerView')).toHaveLength(1);
      const response = await spy.mock.results.find((_, i) => spy.mock.calls[i]?.[1].method === 'callTool')?.value;
      expect(response.error).not.toHaveProperty('retry');
      await client.release();
    } finally {
      invoke.mockRestore();
      spy.mockRestore();
      await f.close();
    }
  });

for (const action of ['replacement', 'close'] as const)
  it(`does not replay or leak a renewed handle when ${action} races with renewal`, async () => {
    const f = await singletonFixture();
    const actual = rpc.requestDaemon;
    const registered = gate(),
      resume = gate();
    let registrations = 0;
    const spy = vi.spyOn(rpc, 'requestDaemon').mockImplementation(async (...args) => {
      const response = await actual(...args);
      if (args[1].method === 'registerView' && ++registrations === 2) {
        registered.open();
        await resume.promise;
      }
      return response;
    });
    let clock: { mockRestore(): void } | undefined;
    let pending: Promise<unknown> | undefined;
    try {
      const client = f.client();
      await client.callTool({ server: 'fixture', tool: 'identity' });
      clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60_000);
      expect(f.host.status().views).toBe(0);
      pending = expect(client.callTool({ server: 'fixture', tool: 'identity' })).rejects.toMatchObject({
        code: 'view_expired',
      });
      await registered.promise;
      if (action === 'replacement') client.setDefinitions([{ ...f.definition, env: { VALUE: 'replacement' } }]);
      const closing = action === 'close' ? client.release() : undefined;
      resume.open();
      await pending;
      await closing;
      expect(spy.mock.calls.filter(([, request]) => request.method === 'callTool')).toHaveLength(2);
      if (action === 'replacement')
        expect(fixtureResult(await client.callTool({ server: 'fixture', tool: 'identity' })).value).toBe('replacement');
      await client.release();
      expect(f.host.status().views).toBe(0);
    } finally {
      resume.open();
      await pending;
      clock?.mockRestore();
      spy.mockRestore();
      await f.close();
    }
  });

it('does not replay across a daemon generation change and releases the replacement handle', async () => {
  const f = await singletonFixture();
  // oxlint-disable-next-line typescript/unbound-method -- Rebound to the intercepted broker with call below.
  const register = DaemonBroker.prototype.register;
  let registrations = 0;
  let replacement: { view: string; generation: string } | undefined;
  let clock: { mockRestore(): void } | undefined;
  const registrationSpy = vi.spyOn(DaemonBroker.prototype, 'register').mockImplementation(function (
    this: DaemonBroker,
    params: unknown
  ) {
    // Simulate daemon cutover exactly between the expired operation's response
    // and the client's renewal, while retaining the real socket/serialization.
    if (++registrations === 2) Object.defineProperty(this, 'generation', { value: 'replacement-daemon-generation' });
    const handle = register.call(this, params);
    if (registrations === 2) replacement = handle;
    return handle;
  });
  const spy = vi.spyOn(rpc, 'requestDaemon');
  try {
    const client = f.client();
    await client.callTool({ server: 'fixture', tool: 'identity' });
    clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60_000);
    expect(f.host.status().views).toBe(0);
    await expect(client.callTool({ server: 'fixture', tool: 'identity' })).rejects.toMatchObject({
      code: 'daemon_generation_changed',
    });
    await client.release();
    expect(spy.mock.calls.filter(([, request]) => request.method === 'callTool')).toHaveLength(2);
    expect(registrations).toBe(2);
    expect(
      spy.mock.calls
        .filter(([, request]) => request.method === 'releaseView')
        .map(([, request]) => ({
          view: request.view,
          generation: request.generation,
        }))
    ).toEqual([replacement]);
    expect(f.host.status().views).toBe(0);
  } finally {
    clock?.mockRestore();
    registrationSpy.mockRestore();
    spy.mockRestore();
    await f.close();
  }
});
