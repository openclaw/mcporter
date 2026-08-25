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

// Every reserved word, contextual keyword and intrinsic type name TypeScript spells; a schema is
// free to carry any of them as an `outputSchema.title`.
const TYPESCRIPT_KEYWORDS = [
  'abstract',
  'accessor',
  'any',
  'as',
  'asserts',
  'async',
  'await',
  'bigint',
  'boolean',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'constructor',
  'continue',
  'debugger',
  'declare',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'get',
  'global',
  'if',
  'implements',
  'import',
  'in',
  'infer',
  'instanceof',
  'interface',
  'intrinsic',
  'is',
  'keyof',
  'let',
  'module',
  'namespace',
  'never',
  'new',
  'null',
  'number',
  'object',
  'of',
  'out',
  'override',
  'package',
  'private',
  'protected',
  'public',
  'readonly',
  'require',
  'return',
  'satisfies',
  'set',
  'static',
  'string',
  'super',
  'switch',
  'symbol',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'unique',
  'unknown',
  'var',
  'void',
  'while',
  'with',
  'yield',
];

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

function parseDiagnosticsOf(source: string): string[] {
  const parsed = ts.createSourceFile('emit.ts', source, ts.ScriptTarget.ES2022, false, ts.ScriptKind.TS);
  const diagnostics = (parsed as { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  return diagnostics.map((entry) => ts.flattenDiagnosticMessageText(entry.messageText, '\n'));
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
      expect(parseDiagnosticsOf(source)).toEqual([]);
    }
  });

  // Four cases render the same module for a different title, so the rendering lives here and each
  // case is left with the title it is about.
  function renderTypesForTitle(title: string): string {
    const titledTool: ServerToolInfo = {
      ...dashedTool,
      name: 'search',
      outputSchema: { title },
    };
    const docs = emitTsTestInternals.buildDocEntries('integration', [buildToolMetadata(titledTool)], true);
    return renderTypesModule({
      interfaceName: 'IntegrationTools',
      docs,
      metadata: {
        server: integrationDefinition,
        generatorLabel: 'mcporter@test',
        generatedAt: new Date('2025-11-07T00:00:00Z'),
      },
    });
  }

  it('keeps a multi-word outputSchema title parseable in the emitted module', () => {
    const types = renderTypesForTitle('Search Results');

    expect(parseDiagnosticsOf(types)).toEqual([]);
    expect(types).toContain('Promise<SearchResults>');
  });

  it('keeps a reserved-word outputSchema title parseable in the emitted module', () => {
    const types = renderTypesForTitle('class');

    expect(parseDiagnosticsOf(types)).toEqual([]);
    expect(types).toContain('Promise<Class>');
  });

  it('keeps a type-context keyword outputSchema title parseable in the emitted module', () => {
    const types = renderTypesForTitle('keyof');

    expect(parseDiagnosticsOf(types)).toEqual([]);
    expect(types).toContain('Promise<Keyof>');
  });

  // Which spellings TypeScript refuses in a type position is the parser's answer rather than ours,
  // so every keyword is rendered and handed back to the parser instead of compared against a copy
  // of the set the source keeps.
  it.each(TYPESCRIPT_KEYWORDS)('keeps the outputSchema title %s parseable in the emitted module', (keyword) => {
    const types = renderTypesForTitle(keyword);

    expect(parseDiagnosticsOf(types)).toEqual([]);
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

  it('does not leave a .d suffix when importing generated declaration files', () => {
    expect(emitTsTestInternals.computeImportPath('/tmp/client.ts', '/tmp/client.d.ts')).toBe('./client');
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
