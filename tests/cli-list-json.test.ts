import { describe, expect, it, vi } from 'vitest';
import { handleList as runHandleList } from '../src/cli/list-command.js';
import type { ServerDefinition } from '../src/config.js';
import type { Runtime } from '../src/runtime.js';

const healthyDefinition: ServerDefinition = {
  name: 'healthy',
  command: { kind: 'http', url: new URL('https://healthy.example.com/mcp') },
};

const authDefinition: ServerDefinition = {
  name: 'auth-server',
  command: { kind: 'http', url: new URL('https://auth.example.com/mcp') },
};

function createRuntime(): Runtime {
  const definitions = [healthyDefinition, authDefinition];
  return {
    getDefinitions: () => definitions,
    getDefinition: (name: string) => {
      const definition = definitions.find((entry) => entry.name === name);
      if (!definition) {
        throw new Error(`Unknown server '${name}'`);
      }
      return definition;
    },
    registerDefinition: vi.fn(),
    listTools: vi.fn((name: string) => {
      if (name === 'healthy') {
        return Promise.resolve([{ name: 'list_documents' }]);
      }
      return Promise.reject(new Error('HTTP error 401: auth required'));
    }),
  } as unknown as Runtime;
}

describe('handleList JSON output', () => {
  it('emits aggregated status counts', async () => {
    const runtime = createRuntime();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await runHandleList(runtime, ['--json']);

      const payload = JSON.parse(logSpy.mock.calls.at(-1)?.[0] ?? '{}');
      expect(payload.mode).toBe('list');
      expect(payload.counts.auth).toBe(1);
      const healthyEntry = payload.servers.find((entry: { name: string }) => entry.name === 'healthy');
      expect(healthyEntry.status).toBe('ok');
      const authEntry = payload.servers.find((entry: { name: string }) => entry.name === 'auth-server');
      expect(authEntry.status).toBe('auth');
      expect(authEntry.issue.kind).toBe('auth');
      expect(process.exitCode).toBeUndefined();
    } finally {
      logSpy.mockRestore();
      process.exitCode = previousExitCode;
    }
  });

  it('sets a non-zero exit code for unhealthy multi-server checks when requested', async () => {
    const runtime = createRuntime();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    try {
      await runHandleList(runtime, ['--json', '--exit-code']);

      const payload = JSON.parse(logSpy.mock.calls.at(-1)?.[0] ?? '{}');
      expect(payload.counts.auth).toBe(1);
      expect(process.exitCode).toBe(1);
    } finally {
      logSpy.mockRestore();
      process.exitCode = previousExitCode;
    }
  });

  it('suppresses output and sets the exit code for quiet checks', async () => {
    const runtime = createRuntime();
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await runHandleList(runtime, ['--quiet']);

      expect(logSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      process.exitCode = previousExitCode;
    }
  });

  it('emits a concise single-server status payload', async () => {
    const runtime = createRuntime();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runHandleList(runtime, ['healthy', '--status', '--json']);

    const payload = JSON.parse(logSpy.mock.calls.at(-1)?.[0] ?? '{}');
    expect(payload.mode).toBe('list');
    expect(payload.counts.ok).toBe(1);
    expect(payload.servers).toHaveLength(1);
    expect(payload.servers[0].name).toBe('healthy');
    expect(payload.servers[0].status).toBe('ok');

    logSpy.mockRestore();
  });

  it('rejects status checks for configured tool selectors', async () => {
    const runtime = createRuntime();

    await expect(runHandleList(runtime, ['healthy.list_documents', '--status'])).rejects.toThrow(
      '--status cannot be used with a tool selector.'
    );
  });
});
