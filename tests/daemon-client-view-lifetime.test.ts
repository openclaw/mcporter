import { expect, it, vi } from 'vitest';
import * as rpc from '../src/daemon/socket-rpc.js';
import { singletonFixture, fixtureResult } from './helpers/singleton.js';

function gate() {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, open: () => resolve() };
}

it('retains a same-client captured handle across replacement and close until RPC settlement', async () => {
  const f = await singletonFixture();
  const admitted = gate(),
    resume = gate();
  const actual = rpc.requestDaemon;
  const events: string[] = [];
  let oldView: string | undefined;
  let pending: Promise<unknown> | undefined;
  const spy = vi.spyOn(rpc, 'requestDaemon').mockImplementation(async (...args) => {
    const request = args[1];
    if (request.method === 'callTool' && (request.params as { tool: string }).tool === 'delayed') {
      oldView = request.view;
      admitted.open();
      await resume.promise;
      const response = await actual(...args);
      events.push('settled');
      return response;
    }
    if (request.method === 'releaseView' && request.view === oldView) events.push('released');
    return actual(...args);
  });
  try {
    const client = f.client();
    const first = fixtureResult(await client.callTool({ server: 'fixture', tool: 'identity' }));
    pending = client.callTool({ server: 'fixture', tool: 'delayed' });
    await admitted.promise;
    client.setDefinitions([{ ...f.definition, env: { VALUE: 'replacement' } }]);
    const next = fixtureResult(await client.callTool({ server: 'fixture', tool: 'identity' }));
    expect(next.value).toBe('replacement');
    expect(next.id).not.toBe(first.id);
    expect(events).toEqual([]);
    expect(f.host.status().views).toBe(2);
    let closed = false;
    const closing = client.release().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    resume.open();
    const old = fixtureResult(await pending);
    expect(old.id).toBe(first.id);
    expect(old.count).toBe(first.count + 1);
    await closing;
    expect(events).toEqual(['settled', 'released']);
    expect(f.host.status().views).toBe(0);
  } finally {
    resume.open();
    await pending?.catch(() => {});
    spy.mockRestore();
    await f.close();
  }
});

for (const failure of ['registration', 'operation'] as const)
  it(`does not let an old ${failure} failure clear the new epoch or shadow the original error`, async () => {
    const f = await singletonFixture();
    const captured = gate(),
      resume = gate();
    const actual = rpc.requestDaemon;
    const error = Object.assign(new Error('synthetic original failure'), { code: 'ECONNRESET' });
    let hold = true;
    let pending: Promise<unknown> | undefined;
    const spy = vi.spyOn(rpc, 'requestDaemon').mockImplementation(async (...args) => {
      if (hold && args[1].method === (failure === 'registration' ? 'registerView' : 'callTool')) {
        hold = false;
        captured.open();
        await resume.promise;
        throw error;
      }
      return actual(...args);
    });
    try {
      const client = f.client();
      pending = expect(client.callTool({ server: 'fixture', tool: 'identity' })).rejects.toBe(error);
      await captured.promise;
      const definition = { ...f.definition, env: { VALUE: 'new' }, allowedTools: ['identity'] };
      const info = { name: 'snapshot', version: '1' };
      client.setDefinitions([definition], info);
      definition.env.VALUE = 'mutated';
      definition.allowedTools.push('secret');
      info.name = 'mutated';
      const current = fixtureResult(await client.callTool({ server: 'fixture', tool: 'identity' }));
      expect(current.value).toBe('new');
      resume.open();
      await pending;
      expect(fixtureResult(await client.callTool({ server: 'fixture', tool: 'identity' })).id).toBe(current.id);
      await expect(client.callTool({ server: 'fixture', tool: 'secret' })).rejects.toMatchObject({
        code: 'tool_not_allowed',
      });
      const registrations = spy.mock.calls.filter(([, request]) => request.method === 'registerView');
      expect(registrations).toHaveLength(2);
      expect(registrations[1]?.[1].params).toMatchObject({ clientInfo: { name: 'snapshot', version: '1' } });
      await client.release();
      expect(f.host.status().views).toBe(0);
    } finally {
      resume.open();
      await pending;
      spy.mockRestore();
      await f.close();
    }
  });

it('releases a pending successful registration on close, without changing its captured definitions', async () => {
  const f = await singletonFixture();
  const captured = gate(),
    resume = gate();
  const actual = rpc.requestDaemon;
  let held = false;
  const spy = vi.spyOn(rpc, 'requestDaemon').mockImplementation(async (...args) => {
    if (!held && args[1].method === 'status') {
      held = true;
      captured.open();
      await resume.promise;
    }
    return actual(...args);
  });
  let pending: Promise<unknown> | undefined;
  try {
    const client = f.client();
    pending = client.callTool({ server: 'fixture', tool: 'identity' });
    await captured.promise;
    client.setDefinitions([{ ...f.definition, env: { VALUE: 'replacement' } }]);
    const closing = client.release();
    resume.open();
    expect(fixtureResult(await pending).value).toBe('original');
    await closing;
    expect(f.host.status().views).toBe(0);
  } finally {
    resume.open();
    await pending?.catch(() => {});
    spy.mockRestore();
    await f.close();
  }
});

it('preserves an operation error when releasing its retired view also fails', async () => {
  const f = await singletonFixture();
  const actual = rpc.requestDaemon;
  const operationError = Object.assign(new Error('synthetic operation failure'), { code: 'ECONNRESET' });
  const cleanupError = new Error('synthetic release response lost');
  const released = gate();
  const spy = vi.spyOn(rpc, 'requestDaemon').mockImplementation(async (...args) => {
    if (args[1].method === 'callTool') throw operationError;
    const response = await actual(...args);
    if (args[1].method === 'releaseView') {
      released.open();
      throw cleanupError;
    }
    return response;
  });
  try {
    const client = f.client();
    await expect(client.callTool({ server: 'fixture', tool: 'identity' })).rejects.toBe(operationError);
    const closing = expect(client.release()).rejects.toBe(cleanupError);
    await released.promise;
    await closing;
    expect(f.host.status().views).toBe(0);
    expect(spy.mock.calls.filter(([, request]) => request.method === 'releaseView')).toHaveLength(1);
  } finally {
    spy.mockRestore();
    await f.close();
  }
});
