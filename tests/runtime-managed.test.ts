import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Runtime } from '../src/runtime.js';

const daemonClientFactory = vi.fn();
const createKeepAliveRuntimeMock = vi.fn();
const isKeepAliveServerMock = vi.fn(
  (definition: { lifecycle?: { mode?: string } }) => definition.lifecycle?.mode === 'keep-alive'
);
const resolveConfigPathMock = vi.fn((configPath?: string, rootDir?: string) => ({
  path: configPath ?? `${rootDir ?? process.cwd()}/mcporter.json`,
  explicit: Boolean(configPath),
}));

const loadServerDefinitionsMock = vi.fn();

vi.mock('../src/config.js', () => ({
  loadServerDefinitions: loadServerDefinitionsMock,
  resolveConfigPath: resolveConfigPathMock,
}));

vi.mock('../src/daemon/client.js', () => ({
  DaemonClient: class {
    constructor(options: unknown) {
      daemonClientFactory(options);
    }
  },
}));

vi.mock('../src/daemon/runtime-wrapper.js', () => ({
  createKeepAliveRuntime: createKeepAliveRuntimeMock,
}));

vi.mock('../src/lifecycle.js', () => ({
  isKeepAliveServer: isKeepAliveServerMock,
}));

vi.mock('../src/runtime/transport.js', () => ({
  createClientContext: vi.fn(),
}));

vi.mock('../src/sdk-patches.js', () => ({}));

async function loadRuntimeModule() {
  return await import('../src/runtime.js');
}

describe('createManagedRuntime', () => {
  beforeEach(() => {
    loadServerDefinitionsMock.mockReset();
    daemonClientFactory.mockReset();
    createKeepAliveRuntimeMock.mockReset();
    isKeepAliveServerMock.mockClear();
    resolveConfigPathMock.mockClear();
  });

  it('wraps config-backed keep-alive runtimes with the daemon client', async () => {
    loadServerDefinitionsMock.mockResolvedValue([
      {
        name: 'chrome-devtools',
        command: { kind: 'stdio', command: 'node', args: [] },
        lifecycle: { mode: 'keep-alive' },
      },
      {
        name: 'context7',
        command: { kind: 'http', url: new URL('https://example.com') },
      },
    ]);
    const wrappedRuntime = { wrapped: true } as unknown as Runtime;
    createKeepAliveRuntimeMock.mockReturnValue(wrappedRuntime);

    const { createManagedRuntime } = await loadRuntimeModule();
    const runtime = await createManagedRuntime({
      configPath: '/tmp/custom.json',
      configExplicit: true,
      rootDir: '/repo',
    });

    expect(resolveConfigPathMock).toHaveBeenCalledWith('/tmp/custom.json', '/repo');
    expect(loadServerDefinitionsMock).toHaveBeenCalledWith({
      configPath: '/tmp/custom.json',
      rootDir: '/repo',
    });
    expect(daemonClientFactory).toHaveBeenCalledWith({
      configPath: '/tmp/custom.json',
      configExplicit: true,
      rootDir: '/repo',
    });
    expect(createKeepAliveRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        getDefinitions: expect.any(Function),
      }),
      expect.objectContaining({
        keepAliveServers: new Set(['chrome-devtools']),
      })
    );
    expect(runtime).toBe(wrappedRuntime);
  });

  it('returns a plain runtime when explicit servers are provided', async () => {
    const { createManagedRuntime } = await loadRuntimeModule();
    const runtime = await createManagedRuntime({
      servers: [
        {
          name: 'chrome-devtools',
          command: { kind: 'stdio', command: 'node', args: [] },
          lifecycle: { mode: 'keep-alive' },
        },
      ] as never,
      rootDir: '/repo',
    });

    expect(loadServerDefinitionsMock).not.toHaveBeenCalled();
    expect(daemonClientFactory).not.toHaveBeenCalled();
    expect(createKeepAliveRuntimeMock).not.toHaveBeenCalled();
    expect(runtime.listServers()).toEqual(['chrome-devtools']);
  });

  it('returns a plain runtime when there are no keep-alive servers', async () => {
    loadServerDefinitionsMock.mockResolvedValue([
      {
        name: 'context7',
        command: { kind: 'http', url: new URL('https://example.com') },
      },
    ]);

    const { createManagedRuntime } = await loadRuntimeModule();
    const runtime = await createManagedRuntime({ rootDir: '/repo' });

    expect(daemonClientFactory).not.toHaveBeenCalled();
    expect(createKeepAliveRuntimeMock).not.toHaveBeenCalled();
    expect(runtime.listServers()).toEqual(['context7']);
  });
});
