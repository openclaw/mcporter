import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { __test as emitTsTestInternals, handleEmitTs } from '../src/cli/emit-ts-command.js';
import { renderClientModule, renderTypesModule } from '../src/cli/emit-ts-templates.js';
import { buildToolMetadata } from '../src/cli/generate/tools.js';
import type { Runtime } from '../src/runtime.js';
import type { ServerToolInfo } from '../src/runtime.js';
import { integrationDefinition, listCommentsTool } from './fixtures/tool-fixtures.js';

const dashedTool: ServerToolInfo = {
  name: 'API-post-page',
  description: 'Create a Notion page',
  inputSchema: {
    type: 'object',
    properties: {
      parent: { type: 'string', description: 'Parent id' },
    },
    required: ['parent'],
  },
  outputSchema: { title: 'Page' },
};

function createRuntimeStub(): Runtime {
  return {
    listServers: () => ['integration'],
    getDefinitions: () => [integrationDefinition],
    getDefinition: (name: string) => {
      if (name !== 'integration') {
        throw new Error(`Server '${name}' not found.`);
      }
      return integrationDefinition;
    },
    registerDefinition: () => {},
    listTools: async () => [listCommentsTool],
    callTool: async () => ({}),
    listResources: async () => ({}),
    connect: async () => {
      throw new Error('not implemented');
    },
    close: async () => {},
  } as unknown as Runtime;
}

describe('emit-ts templates', () => {
  it('renders type declarations with CallResult returns', () => {
    const docs = emitTsTestInternals.buildDocEntries('integration', [buildToolMetadata(listCommentsTool)], false);
    const metadata = {
      server: integrationDefinition,
      generatorLabel: 'mcporter@test',
      generatedAt: new Date('2025-11-07T00:00:00Z'),
    };
    const source = renderTypesModule({ interfaceName: 'IntegrationTools', docs, metadata });
    expect(source).toContain('export interface IntegrationTools');
    expect(source).toContain('Promise<CommentList>');
    expect(source).toContain('Issue identifier');
  });

  it('quotes generated TypeScript members for tool names that are not identifiers', () => {
    const docs = emitTsTestInternals.buildDocEntries('integration', [buildToolMetadata(dashedTool)], true);
    const metadata = {
      server: integrationDefinition,
      generatorLabel: 'mcporter@test',
      generatedAt: new Date('2025-11-07T00:00:00Z'),
    };
    const types = renderTypesModule({ interfaceName: 'IntegrationTools', docs, metadata });
    const client = renderClientModule({
      interfaceName: 'IntegrationTools',
      docs,
      metadata,
      typesImportPath: './integration-client',
    });

    expect(types).toContain('"API-post-page"(parent: string): Promise<Page>;');
    expect(client).toContain('async "API-post-page"(params: Parameters<IntegrationTools["API-post-page"]>[0])');
    expect(client).toContain('proxy.aPIPostPage');

    for (const source of [types, client]) {
      const parsed = ts.createSourceFile('emit.ts', source, ts.ScriptTarget.ES2022, false, ts.ScriptKind.TS);
      const diagnostics = (parsed as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
      expect(diagnostics.map((entry) => ts.flattenDiagnosticMessageText(entry.messageText, '\n'))).toEqual([]);
    }
  });

  it('renders client module that wraps proxy calls', () => {
    const docs = emitTsTestInternals.buildDocEntries('integration', [buildToolMetadata(listCommentsTool)], true);
    const metadata = {
      server: integrationDefinition,
      generatorLabel: 'mcporter@test',
      generatedAt: new Date('2025-11-07T00:00:00Z'),
    };
    const source = renderClientModule({
      interfaceName: 'IntegrationTools',
      docs,
      metadata,
      typesImportPath: './integration-client',
    });
    expect(source).toContain('createIntegrationClient');
    expect(source).toContain('wrapCallResult');
    expect(source).toContain('proxy.listComments');
  });
});

describe('handleEmitTs', () => {
  it('writes client and types files to disk', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'emit-ts-'));
    const runtime = createRuntimeStub();
    const clientPath = path.join(tmpDir, 'integration-client.ts');
    await handleEmitTs(runtime, ['integration', '--out', clientPath, '--mode', 'client']);
    const typesPath = path.join(tmpDir, 'integration-client.d.ts');
    const clientSource = await fs.readFile(clientPath, 'utf8');
    const typesSource = await fs.readFile(typesPath, 'utf8');
    expect(clientSource).toContain('createIntegrationClient');
    expect(typesSource).toContain('export interface IntegrationTools');
  });

  it('resolves HTTP selectors when emitting definitions', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'emit-ts-http-'));
    const runtime = createRuntimeStub();
    const typesPath = path.join(tmpDir, 'integration-tools.d.ts');
    await handleEmitTs(runtime, ['https://www.example.com/mcp.getComponents', '--out', typesPath, '--mode', 'types']);
    const typesSource = await fs.readFile(typesPath, 'utf8');
    expect(typesSource).toContain('export interface HttpsWwwExampleComMcpGetComponentsTools');
  });

  it('accepts scheme-less HTTP selectors when emitting definitions', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'emit-ts-http-scheme-'));
    const runtime = createRuntimeStub();
    const typesPath = path.join(tmpDir, 'integration-tools.d.ts');
    await handleEmitTs(runtime, ['example.com/mcp.getComponents', '--out', typesPath, '--mode', 'types']);
    const typesSource = await fs.readFile(typesPath, 'utf8');
    expect(typesSource).toContain('export interface ExampleComMcpGetComponentsTools');
  });

  it('emits JSON summaries when --json is provided', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'emit-ts-json-'));
    const runtime = createRuntimeStub();
    const typesPath = path.join(tmpDir, 'integration-tools.d.ts');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleEmitTs(runtime, ['integration', '--out', typesPath, '--mode', 'types', '--json']);
    const payload = JSON.parse(logSpy.mock.calls.at(-1)?.[0] ?? '{}');
    expect(payload.mode).toBe('types');
    expect(payload.server).toBe('integration');
    logSpy.mockRestore();
  });

  it('emits JSON summaries for client mode', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'emit-ts-json-client-'));
    const runtime = createRuntimeStub();
    const clientPath = path.join(tmpDir, 'integration-client.ts');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await handleEmitTs(runtime, ['integration', '--out', clientPath, '--mode', 'client', '--json']);
    const payload = JSON.parse(logSpy.mock.calls.at(-1)?.[0] ?? '{}');
    expect(payload.mode).toBe('client');
    expect(payload.clientOutPath).toBe(clientPath);
    expect(payload.typesOutPath.endsWith('.d.ts')).toBe(true);
    const typesExists = await fs
      .access(payload.typesOutPath)
      .then(() => true)
      .catch(() => false);
    expect(typesExists).toBe(true);
    logSpy.mockRestore();
  });
});
