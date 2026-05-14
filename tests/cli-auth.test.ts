import { describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { markOAuthFlowError } from '../src/runtime/oauth.js';

process.env.MCPORTER_DISABLE_AUTORUN = '1';
const cliModulePromise = import('../src/cli.js');

const createRuntimeDouble = () => {
  const definitions = new Map<string, Record<string, unknown>>();
  const registerDefinition = vi.fn((definition: Record<string, unknown>) => {
    definitions.set(definition.name as string, { ...definition });
  });
  const getDefinition = vi.fn((name: string) => {
    const definition = definitions.get(name);
    if (!definition) {
      throw new Error(`Unknown MCP server '${name}'.`);
    }
    return definition;
  });
  const listTools = vi.fn().mockResolvedValue([{ name: 'ok' }]);
  const runtime = {
    registerDefinition,
    getDefinition,
    getDefinitions: () => Array.from(definitions.values()),
    listTools,
  } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;
  return { runtime, listTools };
};

describe('mcporter auth ad-hoc support', () => {
  it('registers ad-hoc HTTP servers via --http-url', async () => {
    const { handleAuth } = await cliModulePromise;
    const { runtime, listTools } = createRuntimeDouble();

    await handleAuth(runtime, ['--http-url', 'https://mcp.deepwiki.com/sse']);

    expect(listTools).toHaveBeenCalledWith('mcp-deepwiki-com-sse', { autoAuthorize: true });
  });

  it('accepts bare URLs as the auth target', async () => {
    const { handleAuth } = await cliModulePromise;
    const { runtime, listTools } = createRuntimeDouble();

    await handleAuth(runtime, ['https://mcp.supabase.com/mcp']);

    expect(listTools).toHaveBeenCalledWith('mcp-supabase-com-mcp', { autoAuthorize: true });
  });

  it('reuses configured servers when auth target is a URL', async () => {
    const { handleAuth } = await cliModulePromise;
    const definition = {
      name: 'vercel',
      command: { kind: 'http', url: new URL('https://mcp.vercel.com') },
      tokenCacheDir: '/tmp/cache',
    } as ServerDefinition;
    const registerDefinition = vi.fn();
    const listTools = vi.fn().mockResolvedValue([{ name: 'ok' }]);
    const runtime = {
      getDefinitions: () => [definition],
      registerDefinition,
      listTools,
      getDefinition: () => definition,
    } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;

    await handleAuth(runtime, ['https://mcp.vercel.com']);

    expect(listTools).toHaveBeenCalledWith('vercel', { autoAuthorize: true });
    expect(registerDefinition).not.toHaveBeenCalled();
  });

  it('passes no-browser OAuth session options when --no-browser is provided', async () => {
    const { handleAuth } = await cliModulePromise;
    const definition = {
      name: 'linear',
      command: { kind: 'http', url: new URL('https://mcp.linear.app/mcp') },
      auth: 'oauth',
    } as ServerDefinition;
    const listTools = vi.fn().mockResolvedValue([{ name: 'ok' }]);
    const runtime = {
      getDefinitions: () => [definition],
      registerDefinition: vi.fn(),
      listTools,
      getDefinition: () => definition,
    } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;

    await handleAuth(runtime, ['linear', '--no-browser']);

    expect(listTools).toHaveBeenCalledWith(
      'linear',
      expect.objectContaining({
        autoAuthorize: true,
        oauthSessionOptions: expect.objectContaining({ suppressBrowserLaunch: true }),
      })
    );
  });

  it('supports documented --browser none as a no-browser alias', async () => {
    const { handleAuth } = await cliModulePromise;
    const definition = {
      name: 'linear',
      command: { kind: 'http', url: new URL('https://mcp.linear.app/mcp') },
      auth: 'oauth',
    } as ServerDefinition;
    const listTools = vi.fn().mockResolvedValue([{ name: 'ok' }]);
    const runtime = {
      getDefinitions: () => [definition],
      registerDefinition: vi.fn(),
      listTools,
      getDefinition: () => definition,
    } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;

    await handleAuth(runtime, ['linear', '--browser', 'none']);

    expect(listTools).toHaveBeenCalledWith(
      'linear',
      expect.objectContaining({
        autoAuthorize: true,
        oauthSessionOptions: expect.objectContaining({ suppressBrowserLaunch: true }),
      })
    );
  });

  it('rejects unsupported --browser values', async () => {
    const { handleAuth } = await cliModulePromise;
    const definition = {
      name: 'linear',
      command: { kind: 'http', url: new URL('https://m.linear.app/mcp') },
      auth: 'oauth',
    } as ServerDefinition;
    const runtime = {
      getDefinitions: () => [definition],
      registerDefinition: vi.fn(),
      listTools: vi.fn().mockResolvedValue([{ name: 'ok' }]),
      getDefinition: () => definition,
    } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;

    await expect(handleAuth(runtime, ['linear', '--browser', 'auto'])).rejects.toThrow(/--browser must be 'none'/);
  });

  it('prints only the authorization URL to stdout in no-browser text mode', async () => {
    const { handleAuth } = await cliModulePromise;
    const definition = {
      name: 'linear',
      command: { kind: 'http', url: new URL('https://mcp.linear.app/mcp') },
      auth: 'oauth',
    } as ServerDefinition;
    const listTools = vi.fn(async (_target, options?: Record<string, unknown>) => {
      const oauthSessionOptions = options?.oauthSessionOptions as
        | { onAuthorizationUrl?: (request: { authorizationUrl: string; redirectUrl: string }) => void | Promise<void> }
        | undefined;
      await oauthSessionOptions?.onAuthorizationUrl?.({
        authorizationUrl: 'https://auth.example.com/authorize?state=abc',
        redirectUrl: 'http://127.0.0.1:54321/callback',
      });
      return [{ name: 'ok' }];
    });
    const runtime = {
      getDefinitions: () => [definition],
      registerDefinition: vi.fn(),
      listTools,
      getDefinition: () => definition,
    } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await handleAuth(runtime, ['linear', '--no-browser']);

    expect(logSpy.mock.calls.map(([message]) => message)).toEqual(['https://auth.example.com/authorize?state=abc']);
    logSpy.mockRestore();
  });

  it('keeps no-browser stdout parseable when info logging is enabled', async () => {
    const [{ handleAuth }, { getActiveLogger, setLogLevel }] = await Promise.all([
      cliModulePromise,
      import('../src/cli/logger-context.js'),
    ]);
    const definition = {
      name: 'linear',
      command: { kind: 'http', url: new URL('https://mcp.linear.app/mcp') },
      auth: 'oauth',
    } as ServerDefinition;
    const listTools = vi.fn(async (_target, options?: Record<string, unknown>) => {
      const oauthSessionOptions = options?.oauthSessionOptions as
        | { onAuthorizationUrl?: (request: { authorizationUrl: string; redirectUrl: string }) => void | Promise<void> }
        | undefined;
      await oauthSessionOptions?.onAuthorizationUrl?.({
        authorizationUrl: 'https://auth.example.com/authorize?state=abc',
        redirectUrl: 'http://127.0.0.1:54321/callback',
      });
      getActiveLogger().info('runtime OAuth status');
      return [{ name: 'ok' }];
    });
    const runtime = {
      getDefinitions: () => [definition],
      registerDefinition: vi.fn(),
      listTools,
      getDefinition: () => definition,
    } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      setLogLevel('info');
      await handleAuth(runtime, ['linear', '--no-browser']);
      expect(logSpy.mock.calls.map(([message]) => message)).toEqual(['https://auth.example.com/authorize?state=abc']);
    } finally {
      setLogLevel('warn');
      logSpy.mockRestore();
    }
  });

  it('prints auth-start JSON once and keeps later failures off stdout', async () => {
    const { handleAuth } = await cliModulePromise;
    const definition = {
      name: 'linear',
      command: { kind: 'http', url: new URL('https://mcp.linear.app/mcp') },
      auth: 'oauth',
    } as ServerDefinition;
    const listTools = vi.fn(async (_target, options?: Record<string, unknown>) => {
      const oauthSessionOptions = options?.oauthSessionOptions as
        | { onAuthorizationUrl?: (request: { authorizationUrl: string; redirectUrl: string }) => void | Promise<void> }
        | undefined;
      await oauthSessionOptions?.onAuthorizationUrl?.({
        authorizationUrl: 'https://auth.example.com/authorize?state=abc',
        redirectUrl: 'http://127.0.0.1:54321/callback',
      });
      throw new Error('OAuth authorization timed out');
    });
    const runtime = {
      getDefinitions: () => [definition],
      registerDefinition: vi.fn(),
      listTools,
      getDefinition: () => definition,
    } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await handleAuth(runtime, ['linear', '--json', '--no-browser']);

    expect(logSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(logSpy.mock.calls[0]?.[0] ?? '{}')).toEqual({
      authorizationUrl: 'https://auth.example.com/authorize?state=abc',
      redirectUrl: 'http://127.0.0.1:54321/callback',
    });
    expect(errorSpy).toHaveBeenCalledWith("Failed to authorize 'linear': OAuth authorization timed out");
    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = undefined;
  });

  it('honors MCPORTER_OAUTH_NO_BROWSER truthy values', async () => {
    const previous = process.env.MCPORTER_OAUTH_NO_BROWSER;
    process.env.MCPORTER_OAUTH_NO_BROWSER = 'yes';
    try {
      const { handleAuth } = await cliModulePromise;
      const definition = {
        name: 'linear',
        command: { kind: 'http', url: new URL('https://mcp.linear.app/mcp') },
        auth: 'oauth',
      } as ServerDefinition;
      const listTools = vi.fn().mockResolvedValue([{ name: 'ok' }]);
      const runtime = {
        getDefinitions: () => [definition],
        registerDefinition: vi.fn(),
        listTools,
        getDefinition: () => definition,
      } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;

      await handleAuth(runtime, ['linear']);

      expect(listTools).toHaveBeenCalledWith(
        'linear',
        expect.objectContaining({
          autoAuthorize: true,
          oauthSessionOptions: expect.objectContaining({ suppressBrowserLaunch: true }),
        })
      );
    } finally {
      if (previous === undefined) {
        delete process.env.MCPORTER_OAUTH_NO_BROWSER;
      } else {
        process.env.MCPORTER_OAUTH_NO_BROWSER = previous;
      }
    }
  });

  it('emits JSON envelopes when auth fails and --json is provided', async () => {
    const { handleAuth } = await cliModulePromise;
    const definition = {
      name: 'linear',
      command: { kind: 'http', url: new URL('https://mcp.linear.app/mcp') },
    } as ServerDefinition;
    const runtime = {
      getDefinitions: () => [definition],
      registerDefinition: vi.fn(),
      listTools: vi.fn().mockRejectedValue(new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:9000')),
      getDefinition: () => definition,
    } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(handleAuth(runtime, ['linear', '--json'])).resolves.toBeUndefined();

    expect(process.exitCode).toBe(1);
    const payload = JSON.parse(logSpy.mock.calls.at(-1)?.[0] ?? '{}');
    expect(payload.server).toBe('linear');
    expect(payload.issue.kind).toBe('offline');

    logSpy.mockRestore();
    errorSpy.mockRestore();
    process.exitCode = undefined;
  });

  it('does not retry OAuth flow errors that already reached the browser-flow path', async () => {
    const { handleAuth } = await cliModulePromise;
    const definition = {
      name: 'figma',
      command: { kind: 'http', url: new URL('https://mcp.figma.com/mcp') },
    } as ServerDefinition;
    const oauthError = markOAuthFlowError(
      new Error('OAuth authorization for figma did not produce an authorization URL. Last error: HTTP 403')
    );
    const listTools = vi.fn().mockRejectedValue(oauthError);
    const runtime = {
      getDefinitions: () => [definition],
      registerDefinition: vi.fn(),
      listTools,
      getDefinition: () => definition,
    } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await handleAuth(runtime, ['figma', '--json']);

    expect(listTools).toHaveBeenCalledTimes(1);
    expect(warnSpy).not.toHaveBeenCalledWith(expect.stringContaining('Retrying with browser flow'));

    logSpy.mockRestore();
    warnSpy.mockRestore();
    process.exitCode = undefined;
  });
});
