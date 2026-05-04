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
});
