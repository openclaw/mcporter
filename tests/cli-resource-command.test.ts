import { describe, expect, it, vi } from 'vitest';
import { handleResource } from '../src/cli/resource-command.js';
import type { Runtime } from '../src/runtime.js';

function createRuntime(): Runtime & {
  listResources: ReturnType<typeof vi.fn>;
  readResource: ReturnType<typeof vi.fn>;
} {
  return {
    listServers: vi.fn(() => ['docs']),
    getDefinitions: vi.fn(() => []),
    getDefinition: vi.fn(() => {
      throw new Error('not implemented');
    }),
    registerDefinition: vi.fn(),
    listTools: vi.fn(async () => []),
    callTool: vi.fn(async () => undefined),
    listResources: vi.fn(async () => ({
      resources: [{ uri: 'memo://one', name: 'One' }],
    })),
    readResource: vi.fn(async (_server: string, uri: string) => ({
      contents: [{ uri, text: 'Hello from resource', mimeType: 'text/plain' }],
    })),
    connect: vi.fn(async () => {
      throw new Error('not implemented');
    }),
    close: vi.fn(async () => undefined),
  };
}

describe('handleResource', () => {
  it('reads a resource URI and prints text content', async () => {
    const runtime = createRuntime();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await handleResource(runtime, ['docs', 'memo://one', '--output', 'text']);
      expect(runtime.readResource).toHaveBeenCalledWith('docs', 'memo://one');
      expect(logSpy).toHaveBeenCalledWith('Hello from resource');
    } finally {
      logSpy.mockRestore();
    }
  });

  it('lists resources when no URI is provided', async () => {
    const runtime = createRuntime();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      await handleResource(runtime, ['docs', '--output', 'json']);
      expect(runtime.listResources).toHaveBeenCalledWith('docs');
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('memo://one'));
    } finally {
      logSpy.mockRestore();
    }
  });

  it('prints structured JSON for resource listing failures', async () => {
    const runtime = createRuntime();
    runtime.listResources.mockRejectedValue(new Error('MCP error -32601: Method not found'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await handleResource(runtime, ['docs', '--output', 'json']);
      const payload = JSON.parse(logSpy.mock.calls.at(-1)?.[0] ?? '{}');
      expect(payload).toMatchObject({
        server: 'docs',
        error: 'MCP error -32601: Method not found',
        issue: {
          kind: 'other',
          rawMessage: 'MCP error -32601: Method not found',
        },
      });
      expect(errorSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('prints a concise error for text resource listing failures', async () => {
    const runtime = createRuntime();
    runtime.listResources.mockRejectedValue(new Error('MCP error -32601: Method not found'));
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      await handleResource(runtime, ['docs']);
      expect(errorSpy).toHaveBeenCalledWith('[mcporter] MCP error -32601: Method not found');
      expect(logSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
