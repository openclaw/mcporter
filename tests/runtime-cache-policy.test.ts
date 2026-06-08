import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createClientContext: vi.fn(),
}));

vi.mock('../src/runtime/transport.js', () => ({
  createClientContext: mocks.createClientContext,
}));

import type { ServerDefinition } from '../src/config.js';
import { createRuntime } from '../src/runtime.js';

type ClientContext = Awaited<ReturnType<Awaited<ReturnType<typeof createRuntime>>['connect']>>;

function fakeContext(
  definition: ServerDefinition,
  clientClose: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue(undefined)
): ClientContext {
  return {
    client: {
      close: clientClose,
    },
    transport: {
      close: vi.fn().mockResolvedValue(undefined),
    },
    definition,
    oauthSession: undefined,
  } as unknown as ClientContext;
}

describe('runtime cache policy', () => {
  beforeEach(() => {
    mocks.createClientContext.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not let stale OAuth promotion overwrite a replacement definition', async () => {
    const initial: ServerDefinition = {
      name: 'oauth',
      command: { kind: 'http', url: new URL('https://old.example.com/mcp') },
    };
    let resolveConnection!: (context: ClientContext) => void;
    let promote!: (definition: ServerDefinition) => void;
    mocks.createClientContext.mockImplementation(
      (
        _definition: ServerDefinition,
        _logger: unknown,
        _clientInfo: unknown,
        options: { onDefinitionPromoted?: (definition: ServerDefinition) => void }
      ) => {
        promote = options.onDefinitionPromoted ?? (() => {});
        return new Promise<ClientContext>((resolve) => {
          resolveConnection = resolve;
        });
      }
    );
    const runtime = await createRuntime({ servers: [initial] });
    const connecting = runtime.connect('oauth');
    const expectation = expect(connecting).rejects.toThrow('superseded');
    await vi.waitFor(() => expect(mocks.createClientContext).toHaveBeenCalled());

    const replacement: ServerDefinition = {
      name: 'oauth',
      command: { kind: 'http', url: new URL('https://new.example.com/mcp') },
    };
    runtime.registerDefinition(replacement, { overwrite: true });
    promote({ ...initial, auth: 'oauth' });
    resolveConnection(fakeContext(initial));

    await expectation;
    expect(runtime.getDefinition('oauth')).toBe(replacement);
  });

  it('uses one replay client across auth posture changes', async () => {
    vi.stubEnv('MCPORTER_REPLAY', 'cache-policy-test');
    const definition: ServerDefinition = {
      name: 'replay',
      command: { kind: 'http', url: new URL('https://replay.example.com/mcp') },
    };
    const context = fakeContext(definition);
    mocks.createClientContext.mockResolvedValue(context);
    const runtime = await createRuntime({ servers: [definition] });

    const first = await runtime.connect('replay');
    const second = await runtime.connect('replay', {
      allowCachedAuth: false,
      disableOAuth: true,
    });

    expect(second).toBe(first);
    expect(mocks.createClientContext).toHaveBeenCalledOnce();
    await runtime.close();
  });

  it('keeps auth posture isolation for servers excluded by the replay filter', async () => {
    vi.stubEnv('MCPORTER_REPLAY', 'cache-policy-test');
    vi.stubEnv('MCPORTER_REPLAY_SERVER', 'other-server');
    const definition: ServerDefinition = {
      name: 'live',
      command: { kind: 'http', url: new URL('https://live.example.com/mcp') },
    };
    const closeMocks: Array<ReturnType<typeof vi.fn>> = [];
    mocks.createClientContext.mockImplementation((current: ServerDefinition) => {
      const closeMock = vi.fn().mockResolvedValue(undefined);
      const context = fakeContext(current, closeMock);
      closeMocks.push(closeMock);
      return Promise.resolve(context);
    });
    const runtime = await createRuntime({ servers: [definition] });

    const first = await runtime.connect('live');
    const second = await runtime.connect('live', {
      allowCachedAuth: false,
    });

    expect(second).not.toBe(first);
    expect(mocks.createClientContext).toHaveBeenCalledTimes(2);
    expect(closeMocks[0]).toHaveBeenCalled();
    await runtime.close();
  });
});
