import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config';
import type { CallResult } from '../src/index.js';
import type { Runtime, ServerToolInfo } from '../src/runtime';
import { writeSchemaCache } from '../src/schema-cache';
import { createServerProxy } from '../src/server-proxy';

function createMockRuntime(
  toolSchemas: Record<string, unknown> = {},
  listToolsImpl?: () => Promise<ServerToolInfo[]>,
  definitionOverrides: Partial<ServerDefinition> = {}
) {
  const listTools = listToolsImpl
    ? vi.fn(listToolsImpl)
    : vi.fn(async () =>
        Object.entries(toolSchemas).map(([name, schema]) => ({
          name,
          description: '',
          inputSchema: schema,
        }))
      );
  const definition: ServerDefinition = {
    name: definitionOverrides.name ?? 'mock',
    description: definitionOverrides.description,
    command: definitionOverrides.command ?? {
      kind: 'stdio',
      command: 'mock',
      args: [],
      cwd: process.cwd(),
    },
    env: definitionOverrides.env,
    auth: definitionOverrides.auth,
    tokenCacheDir: definitionOverrides.tokenCacheDir,
    clientName: definitionOverrides.clientName,
  };

  return {
    callTool: vi.fn(async (_, __, options) => options),
    listTools,
    getDefinition: vi.fn(() => definition),
  };
}

describe('createServerProxy', () => {
  it('maps camelCase property names to kebab-case tool names', async () => {
    const runtime = createMockRuntime({
      'resolve-library-id': {
        type: 'object',
        properties: {
          libraryName: { type: 'string' },
        },
        required: ['libraryName'],
      },
    });
    const context7 = createServerProxy(runtime as unknown as Runtime, 'context7') as Record<string, unknown>;

    const resolver = context7.resolveLibraryId as (args: unknown) => Promise<CallResult>;
    const result = await resolver({ libraryName: 'react' });

    expect(runtime.callTool).toHaveBeenCalledWith('context7', 'resolve-library-id', { args: { libraryName: 'react' } });
    expect(result.raw).toEqual({ args: { libraryName: 'react' } });
  });

  it('merges args and options when both are provided', async () => {
    const runtime = createMockRuntime({
      'some-tool': {
        type: 'object',
        properties: {
          foo: { type: 'string' },
        },
        required: ['foo'],
      },
    });
    const proxy = createServerProxy(runtime as unknown as Runtime, 'foo') as Record<string, unknown>;

    const fn = proxy.someTool as (args: unknown, options: unknown) => Promise<CallResult>;
    const result = await fn({ foo: 'bar' }, { tailLog: true });

    expect(runtime.callTool).toHaveBeenCalledWith('foo', 'some-tool', {
      args: { foo: 'bar' },
      tailLog: true,
    });
    expect(result.raw).toEqual({ args: { foo: 'bar' }, tailLog: true });
  });

  it('supports passing full call options as the first argument', async () => {
    const runtime = createMockRuntime();
    const proxy = createServerProxy(runtime as unknown as Runtime, 'bar') as Record<string, unknown>;

    const fn = proxy.otherTool as (options: unknown) => Promise<CallResult>;
    const result = await fn({ args: { value: 1 }, tailLog: true });

    expect(runtime.callTool).toHaveBeenCalledWith('bar', 'other-tool', {
      args: { value: 1 },
      tailLog: true,
    });
    expect(result.raw).toEqual({ args: { value: 1 }, tailLog: true });
  });

  it('hydrates schemas from disk cache without querying the server', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-schema-cache-'));
    try {
      const definition: ServerDefinition = {
        name: 'cached',
        description: '',
        command: {
          kind: 'stdio',
          command: 'mock',
          args: [],
          cwd: process.cwd(),
        },
        tokenCacheDir: tmpDir,
      };
      await writeSchemaCache(definition, {
        updatedAt: new Date().toISOString(),
        tools: {
          'some-tool': {
            type: 'object',
            properties: { foo: { type: 'string' } },
            required: ['foo'],
          },
        },
      });

      const runtime = createMockRuntime({}, undefined, definition);

      const proxy = createServerProxy(runtime as unknown as Runtime, 'cached') as Record<string, unknown>;

      const fn = proxy.someTool as (args: unknown) => Promise<CallResult>;
      const result = await fn({ foo: 'bar' });

      expect(result.raw).toEqual({ args: { foo: 'bar' } });
      expect(runtime.listTools).toHaveBeenCalled();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('persists schemas to disk after fetching', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-schema-write-'));
    try {
      const runtime = createMockRuntime(
        {
          'some-tool': {
            type: 'object',
            properties: { foo: { type: 'string' } },
            required: ['foo'],
          },
        },
        undefined,
        {
          name: 'persist',
          tokenCacheDir: tmpDir,
        }
      );
      const proxy = createServerProxy(runtime as unknown as Runtime, 'persist') as Record<string, unknown>;

      const fn = proxy.someTool as (args: unknown) => Promise<CallResult>;
      await fn({ foo: 'bar' });

      const snapshotPath = path.join(tmpDir, 'schema.json');
      const snapshotRaw = await fs.readFile(snapshotPath, 'utf8');
      const snapshot = JSON.parse(snapshotRaw) as {
        tools: Record<string, unknown>;
      };
      expect(Object.keys(snapshot.tools)).toContain('some-tool');
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('uses provided initial schemas without hitting listTools', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-schema-initial-'));
    try {
      const runtime = createMockRuntime(
        {},
        async () => {
          throw new Error('listTools should not run when initial schemas set');
        },
        {
          name: 'initial',
          tokenCacheDir: tmpDir,
        }
      );

      const initial = {
        'some-tool': {
          type: 'object',
          properties: { foo: { type: 'string' } },
          required: ['foo'],
        },
      };

      const proxy = createServerProxy(runtime as unknown as Runtime, 'initial', { initialSchemas: initial }) as Record<
        string,
        unknown
      >;

      const fn = proxy.someTool as (args: unknown) => Promise<CallResult>;
      await fn({ foo: 'bar' });

      const snapshotPath = path.join(tmpDir, 'schema.json');
      const snapshotRaw = await fs.readFile(snapshotPath, 'utf8');
      const snapshot = JSON.parse(snapshotRaw) as {
        tools: Record<string, unknown>;
      };
      expect(Object.keys(snapshot.tools)).toContain('some-tool');
      expect(runtime.listTools).not.toHaveBeenCalled();
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('applies schema defaults and validates required arguments', async () => {
    const runtime = createMockRuntime({
      someTool: {
        type: 'object',
        properties: {
          foo: { type: 'number', default: 42 },
          bar: { type: 'string' },
        },
        required: ['foo'],
      },
      otherTool: {
        type: 'object',
        required: ['value'],
      },
    });

    const proxy = createServerProxy(runtime as unknown as Runtime, 'test') as Record<string, unknown>;

    const someTool = proxy.someTool as (options?: unknown) => Promise<CallResult>;
    const result = await someTool({ bar: 'baz' });

    expect(runtime.callTool).toHaveBeenCalledWith('test', 'some-tool', {
      args: { foo: 42, bar: 'baz' },
    });
    expect(result.raw).toEqual({ args: { foo: 42, bar: 'baz' } });

    const otherTool = proxy.otherTool as () => Promise<CallResult>;
    await expect(otherTool()).rejects.toThrow('Missing required arguments');
    expect(runtime.callTool).toHaveBeenCalledTimes(1);
  });

  it('continues when metadata fetch fails', async () => {
    const runtime = createMockRuntime({}, () => Promise.reject(new Error('metadata failure')));

    const proxy = createServerProxy(runtime as unknown as Runtime, 'foo') as Record<string, unknown>;

    const fn = proxy.someTool as (args: unknown) => Promise<CallResult>;
    const result = await fn({ foo: 'bar' });

    expect(runtime.callTool).toHaveBeenCalledWith('foo', 'some-tool', {
      foo: 'bar',
    });
    expect(result.raw).toEqual({ foo: 'bar' });
  });

  it('maps primitive positional arguments onto required schema fields', async () => {
    const runtime = createMockRuntime({
      'get-library-docs': {
        type: 'object',
        properties: {
          context7CompatibleLibraryID: { type: 'string' },
          format: { type: 'string', default: 'markdown' },
        },
        required: ['context7CompatibleLibraryID'],
      },
    });

    const context7 = createServerProxy(runtime as unknown as Runtime, 'context7') as Record<string, unknown>;

    const fn = context7.getLibraryDocs as (arg: unknown) => Promise<CallResult>;
    const result = await fn('/ids/react');

    expect(runtime.callTool).toHaveBeenCalledWith('context7', 'get-library-docs', {
      args: {
        context7CompatibleLibraryID: '/ids/react',
        format: 'markdown',
      },
    });
    expect(result.raw).toEqual({
      args: {
        context7CompatibleLibraryID: '/ids/react',
        format: 'markdown',
      },
    });
  });

  it('supports multi-field positional arguments with additional arg bags', async () => {
    const runtime = createMockRuntime({
      firecrawl_scrape: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          formats: { type: ['string', 'array'], default: 'markdown' },
          waitFor: { type: 'number' },
          mobile: { type: 'boolean', default: false },
        },
        required: ['url'],
      },
    });

    const firecrawl = createServerProxy(runtime as unknown as Runtime, 'firecrawl') as Record<string, unknown>;

    const fn = firecrawl.firecrawlScrape as (
      url: unknown,
      formats: unknown,
      args: unknown,
      options: unknown
    ) => Promise<CallResult>;
    const result = await fn('https://example.com/docs', ['markdown', 'html'], { waitFor: 5000 }, { tailLog: true });

    expect(runtime.callTool).toHaveBeenCalledWith('firecrawl', 'firecrawl_scrape', {
      args: {
        url: 'https://example.com/docs',
        formats: ['markdown', 'html'],
        waitFor: 5000,
        mobile: false,
      },
      tailLog: true,
    });
    expect(result.raw).toEqual({
      args: {
        url: 'https://example.com/docs',
        formats: ['markdown', 'html'],
        waitFor: 5000,
        mobile: false,
      },
      tailLog: true,
    });
  });

  it('threads disableOAuth through schema discovery so proxy.tool({disableOAuth:true}) cannot trigger OAuth during metadata fetch', async () => {
    // Regression for the PR-198 reviewer note: the proxy fired
    // `runtime.listTools(server, { includeSchema: true })` for schema
    // discovery BEFORE parsing the caller's options. On an OAuth
    // server with no cached schema, that pre-call could start an
    // interactive OAuth flow even when the eventual tool call had
    // `disableOAuth: true`. Fix: the proxy must extract disableOAuth
    // up front and pass it to listTools so the no-OAuth contract
    // covers the whole proxy interaction.
    const runtime = createMockRuntime({
      'some-tool': {
        type: 'object',
        properties: {
          foo: { type: 'string' },
          disableOAuth: { type: 'boolean' },
        },
        required: ['foo'],
      },
    });
    const proxy = createServerProxy(runtime as unknown as Runtime, 'mock') as Record<string, unknown>;
    const fn = proxy.someTool as (args: unknown, options: unknown) => Promise<CallResult>;

    await fn({ foo: 'bar' }, { disableOAuth: true });

    // The schema-fetch listTools call must carry disableOAuth: true.
    expect(runtime.listTools).toHaveBeenCalledWith('mock', {
      includeSchema: true,
      disableOAuth: true,
    });
    // And the eventual tool call must too — already covered by the
    // existing KNOWN_OPTION_KEYS handling, asserted here so both
    // halves of the contract are locked together.
    expect(runtime.callTool).toHaveBeenCalledWith('mock', 'some-tool', {
      args: { foo: 'bar' },
      disableOAuth: true,
    });
  });

  it('detects disableOAuth metadata options before later argument objects', async () => {
    const runtime = createMockRuntime({
      'some-tool': {
        type: 'object',
        properties: {
          foo: { type: 'string' },
        },
        required: ['foo'],
      },
    });
    const proxy = createServerProxy(runtime as unknown as Runtime, 'mock') as Record<string, unknown>;
    const fn = proxy.someTool as (options: unknown, args: unknown) => Promise<CallResult>;

    await fn({ disableOAuth: true }, { foo: 'bar' });

    expect(runtime.listTools).toHaveBeenCalledWith('mock', {
      includeSchema: true,
      disableOAuth: true,
    });
    expect(runtime.callTool).toHaveBeenCalledWith('mock', 'some-tool', {
      args: { foo: 'bar' },
      disableOAuth: true,
    });
  });

  it('preserves schema-owned disableOAuth fields after metadata discovery', async () => {
    const runtime = createMockRuntime({
      'some-tool': {
        type: 'object',
        properties: {
          disableOAuth: { type: 'boolean' },
        },
        required: ['disableOAuth'],
      },
    });
    const proxy = createServerProxy(runtime as unknown as Runtime, 'mock') as Record<string, unknown>;
    const fn = proxy.someTool as (args: unknown) => Promise<CallResult>;

    await fn({ disableOAuth: true });

    expect(runtime.listTools).toHaveBeenCalledWith('mock', {
      includeSchema: true,
    });
    expect(runtime.callTool).toHaveBeenCalledWith('mock', 'some-tool', {
      args: { disableOAuth: true },
    });
  });

  it('preserves schema-owned disableOAuth fields beside proxy options', async () => {
    const runtime = createMockRuntime({
      'some-tool': {
        type: 'object',
        properties: {
          disableOAuth: { type: 'boolean' },
        },
        required: ['disableOAuth'],
      },
    });
    const proxy = createServerProxy(runtime as unknown as Runtime, 'mock') as Record<string, unknown>;
    const fn = proxy.someTool as (args: unknown, options: unknown) => Promise<CallResult>;

    await fn({ disableOAuth: true }, { tailLog: true });

    expect(runtime.listTools).toHaveBeenCalledWith('mock', {
      includeSchema: true,
      autoAuthorize: false,
    });
    expect(runtime.callTool).toHaveBeenCalledWith('mock', 'some-tool', {
      args: { disableOAuth: true },
      tailLog: true,
    });
  });

  it('preserves schema-owned disableOAuth fields beside positional arguments', async () => {
    const runtime = createMockRuntime({
      'some-tool': {
        type: 'object',
        properties: {
          value: { type: 'string' },
          disableOAuth: { type: 'boolean' },
        },
        required: ['value', 'disableOAuth'],
      },
    });
    const proxy = createServerProxy(runtime as unknown as Runtime, 'mock') as Record<string, unknown>;
    const fn = proxy.someTool as (value: string, args: unknown) => Promise<CallResult>;

    await fn('x', { disableOAuth: true });

    expect(runtime.callTool).toHaveBeenCalledWith('mock', 'some-tool', {
      args: {
        value: 'x',
        disableOAuth: true,
      },
    });
  });

  it('does not override active OAuth posture when schema discovery is cached', async () => {
    const schema = {
      type: 'object',
      properties: {
        value: { type: 'string' },
        disableOAuth: { type: 'boolean' },
      },
      required: ['value', 'disableOAuth'],
    };
    const runtime = createMockRuntime({ 'some-tool': schema });
    const proxy = createServerProxy(runtime as unknown as Runtime, 'mock', {
      initialSchemas: { 'some-tool': schema },
    }) as Record<string, unknown>;
    const fn = proxy.someTool as (value: string, args: unknown) => Promise<CallResult>;

    await fn('x', { disableOAuth: true });

    expect(runtime.listTools).not.toHaveBeenCalled();
    expect(runtime.callTool).toHaveBeenCalledWith('mock', 'some-tool', {
      args: {
        value: 'x',
        disableOAuth: true,
      },
    });
  });

  it('suppresses schema discovery for split proxy option bags', async () => {
    const runtime = createMockRuntime({
      ping: {
        type: 'object',
        properties: {},
      },
    });
    const proxy = createServerProxy(runtime as unknown as Runtime, 'mock') as Record<string, unknown>;
    const fn = proxy.ping as (options: unknown, additionalOptions: unknown) => Promise<CallResult>;

    await fn({ disableOAuth: true }, { tailLog: true });

    expect(runtime.listTools).toHaveBeenCalledWith('mock', {
      includeSchema: true,
      autoAuthorize: false,
    });
    expect(runtime.callTool).toHaveBeenCalledWith('mock', 'ping', {
      disableOAuth: true,
      tailLog: true,
    });
  });

  it('supports explicit args envelopes for option-only disableOAuth metadata discovery', async () => {
    const runtime = createMockRuntime({
      ping: {
        type: 'object',
        properties: {},
      },
    });
    const proxy = createServerProxy(runtime as unknown as Runtime, 'mock') as Record<string, unknown>;
    const fn = proxy.ping as (options: unknown) => Promise<CallResult>;

    await fn({ args: {}, disableOAuth: true });

    expect(runtime.listTools).toHaveBeenCalledWith('mock', {
      includeSchema: true,
      disableOAuth: true,
    });
    expect(runtime.callTool).toHaveBeenCalledWith('mock', 'ping', {
      args: {},
      disableOAuth: true,
    });
  });

  it('does not join an unsuppressed in-flight schema fetch for a disabled-OAuth call', async () => {
    const tools: ServerToolInfo[] = [
      {
        name: 'ping',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
    ];
    let resolveOrdinary!: (tools: ServerToolInfo[]) => void;
    const listTools = vi.fn((_server: string, options?: { disableOAuth?: boolean }) => {
      if (options?.disableOAuth === true) {
        return Promise.resolve(tools);
      }
      return new Promise<ServerToolInfo[]>((resolve) => {
        resolveOrdinary = resolve;
      });
    });
    const runtime = {
      callTool: vi.fn(async (_, __, options) => options),
      listTools,
      getDefinition: vi.fn(() => {
        throw new Error('no persistent schema cache');
      }),
    };
    const proxy = createServerProxy(runtime as unknown as Runtime, 'mock', {
      cacheSchemas: false,
    }) as Record<string, unknown>;
    const fn = proxy.ping as (options?: unknown) => Promise<CallResult>;

    const ordinary = fn();
    await vi.waitFor(() => expect(listTools).toHaveBeenCalledTimes(1));
    const suppressed = fn({ args: {}, disableOAuth: true });

    await expect(suppressed).resolves.toBeDefined();
    expect(listTools).toHaveBeenNthCalledWith(2, 'mock', {
      includeSchema: true,
      disableOAuth: true,
    });
    resolveOrdinary(tools);
    await ordinary;
  });

  it('preserves schema-owned fields that share proxy option names', async () => {
    const runtime = createMockRuntime({
      wait: {
        type: 'object',
        properties: {
          timeout: { type: 'number' },
        },
        required: ['timeout'],
      },
    });
    const proxy = createServerProxy(runtime as unknown as Runtime, 'mock') as Record<string, unknown>;
    const fn = proxy.wait as (args: unknown) => Promise<CallResult>;

    await fn({ timeout: 1000 });

    expect(runtime.callTool).toHaveBeenCalledWith('mock', 'wait', {
      args: { timeout: 1000 },
    });
  });
});
