import { describe, expect, it, vi } from 'vitest';

process.env.MCPORTER_DISABLE_AUTORUN = '1';
const cliModulePromise = import('../src/cli.js');

describe('CLI call error reporting', () => {
  it('reports connection issues and emits JSON payloads when requested', async () => {
    const { handleCall } = await cliModulePromise;
    const callTool = vi.fn().mockRejectedValue(new Error('SSE error: Non-200 status code (401)'));
    const runtime = {
      callTool,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await handleCall(runtime, ['github.list_repos', '--output', 'json']);

    const payload = JSON.parse(logSpy.mock.calls.at(-1)?.[0] ?? '{}');
    expect(payload.issue?.kind).toBe('auth');
    expect(errorSpy.mock.calls.some((call) => call.join(' ').includes('Authorization required'))).toBe(true);

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('emits structured http envelopes for non-auth transport failures', async () => {
    const { handleCall } = await cliModulePromise;
    const callTool = vi.fn().mockRejectedValue(new Error('SSE error: Non-200 status code (410)'));
    const runtime = {
      callTool,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await handleCall(runtime, ['deepwiki.read_wiki_structure', '--output', 'json']);

    const payload = JSON.parse(logSpy.mock.calls.at(-1)?.[0] ?? '{}');
    expect(payload.issue?.kind).toBe('http');
    expect(payload.issue?.statusCode).toBe(410);
    expect(payload.tool).toBe('read_wiki_structure');
    expect(errorSpy.mock.calls.some((call) => call.join(' ').includes('responded with HTTP 410'))).toBe(true);

    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('reports an offline connection failure once', async () => {
    const { handleCall } = await cliModulePromise;
    const runtime = {
      callTool: vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:9000')),
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as Awaited<ReturnType<(typeof import('../src/runtime.js'))['createRuntime']>>;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(handleCall(runtime, ['local.run'])).rejects.toThrow('ECONNREFUSED');

    const offlineDiagnostics = errorSpy.mock.calls.filter((call) => call.join(' ').includes('appears offline'));
    expect(offlineDiagnostics).toHaveLength(1);
    errorSpy.mockRestore();
  });
});
