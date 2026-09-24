import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { __test as emitTsTestInternals, handleEmitTs } from '../src/cli/emit-ts-command.js';
import { renderClientModule, renderTypesModule } from '../src/cli/emit-ts-templates.js';
import { buildToolMetadata, buildToolMetadataList } from '../src/cli/generate/tools.js';
import type { ServerDefinition } from '../src/config.js';
import { createRuntime, type Runtime } from '../src/runtime.js';
import type { ServerToolInfo } from '../src/runtime.js';
import { createServerProxy } from '../src/server-proxy.js';
import { wrapCallResult } from '../src/result-utils.js';
import { budget } from './helpers/timing.js';
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

const testMetadata = {
  server: integrationDefinition,
  generatorLabel: 'mcporter@test',
  generatedAt: new Date('2025-11-07T00:00:00Z'),
};

function createRuntimeStub(
  tools: ServerToolInfo[] = [listCommentsTool],
  definition: ServerDefinition = integrationDefinition
): Runtime {
  return {
    listServers: () => [definition.name],
    getDefinitions: () => [definition],
    getDefinition: (name: string) => {
      if (name !== definition.name) {
        throw new Error(`Server '${name}' not found.`);
      }
      return definition;
    },
    registerDefinition: () => {},
    listTools: async () => tools,
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
    metadata: testMetadata,
    signatureStyle: 'positional',
  });
}

describe('emit-ts templates', () => {
  it('retains digit-leading and underscore-prefixed tools in types and clients', () => {
    const names = ['1password_get_item', '__1password_get_item', 'tools.search', '__proto__', '__defineGetter__'];
    const tools = buildToolMetadataList(
      names.map((name) => ({ name, inputSchema: { type: 'object', properties: {}, required: [] } })),
      { onCollision: 'skip' }
    );
    const docs = emitTsTestInternals.buildDocEntries('integration', tools, false);
    expect(new Set(docs.map((entry) => entry.toolName))).toEqual(new Set(names));
    const input = { interfaceName: 'IntegrationTools', docs, metadata: testMetadata };
    const types = renderTypesModule({ ...input, signatureStyle: 'positional' });
    const client = renderClientModule(input);
    for (const source of [types, client]) {
      expect(parseDiagnosticsOf(source)).toEqual([]);
      for (const name of names) expect(source).toContain(name);
    }
    expect(client).toContain('return tools["1password_get_item"](params === undefined ? {} : params);');
    expect(client).toContain('return tools.__proto__(params === undefined ? {} : params);');
  });

  it('renders type declarations with CallResult returns', () => {
    const docs = emitTsTestInternals.buildDocEntries('integration', [buildToolMetadata(listCommentsTool)], false);
    const source = renderTypesModule({
      interfaceName: 'IntegrationTools',
      docs,
      metadata: testMetadata,
      signatureStyle: 'positional',
    });
    expect(source).toContain('export interface IntegrationTools');
    expect(source).toContain('Promise<CommentList>');
    expect(source).toContain('Issue identifier');
  });

  it('quotes generated TypeScript members for tool names that are not identifiers', () => {
    const docs = emitTsTestInternals.buildDocEntries('integration', [buildToolMetadata(dashedTool)], true);
    const types = renderTypesModule({
      interfaceName: 'IntegrationTools',
      docs,
      metadata: testMetadata,
      signatureStyle: 'positional',
    });
    const client = renderClientModule({ interfaceName: 'IntegrationTools', docs, metadata: testMetadata });

    expect(types).toContain('"API-post-page"(parent: string): Promise<Page>;');
    expect(client).toContain(
      '"API-post-page"(params: { parent: string } & Record<string, unknown>): Promise<CallResult>;'
    );
    expect(client).toContain('async "API-post-page"(params) {');
    expect(client).toContain('return tools["API-post-page"](params === undefined ? {} : params);');

    for (const source of [types, client]) {
      expect(parseDiagnosticsOf(source)).toEqual([]);
    }
  });

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
    const source = renderClientModule({ interfaceName: 'IntegrationTools', docs, metadata: testMetadata });
    expect(source).toContain('createIntegrationClient');
    expect(source).toContain('export interface IntegrationTools');
    expect(source).toContain('createServerProxy(runtime, "integration")');
    expect(source).toContain('return tools.list_comments(params === undefined ? {} : params);');
    expect(source).not.toContain('import type');
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
    expect(payload.typesOutPath).toBe(path.join(tmpDir, 'integration-client.d.ts'));
    const typesExists = await fs
      .access(payload.typesOutPath)
      .then(() => true)
      .catch(() => false);
    expect(typesExists).toBe(true);
    logSpy.mockRestore();
  });
});

// Chrome DevTools shapes: a tool with two required properties, one with no properties, one whose
// property is a TypeScript reserved word, one whose property is not an identifier, and one with
// schema defaults.
const clickTool: ServerToolInfo = {
  name: 'click',
  description: 'Click an element',
  inputSchema: {
    type: 'object',
    properties: {
      pageId: { type: 'string', description: 'Page identifier' },
      uid: { type: 'string', description: 'Element uid' },
    },
    required: ['pageId', 'uid'],
  },
};

const listPagesTool: ServerToolInfo = {
  name: 'list_pages',
  description: 'List open pages',
  inputSchema: { type: 'object', properties: {}, required: [] },
};

const evaluateScriptTool: ServerToolInfo = {
  name: 'evaluate_script',
  description: 'Evaluate a function on a page',
  inputSchema: {
    type: 'object',
    properties: {
      function: { type: 'string', description: 'Function source' },
      pageId: { type: 'string', description: 'Page identifier' },
    },
    required: ['function'],
  },
};

const fetchTool: ServerToolInfo = {
  name: 'fetch',
  description: 'Fetch a URL',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Target URL' },
      'content-type': { type: 'string', description: 'Expected content type' },
    },
    required: ['url'],
  },
};

const searchTool: ServerToolInfo = {
  name: 'search',
  description: 'Search pages',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search text' },
      limit: { type: 'number', description: 'Maximum results', default: 10 },
      verbose: { type: 'boolean', description: 'Include snippets', default: false },
    },
    required: ['query'],
  },
};

const dynamicTool: ServerToolInfo = {
  name: 'dynamic',
  inputSchema: { type: 'object', additionalProperties: { type: 'string' } },
};
const nullableTool: ServerToolInfo = {
  name: 'nullable',
  inputSchema: { type: 'object', properties: { value: { type: ['string', 'null'] } }, required: ['value'] },
};
const openNamedTool: ServerToolInfo = {
  name: 'open_named',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: { type: 'string' },
  },
};
const closedNamedTool: ServerToolInfo = {
  name: 'closed_named',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' } },
    required: ['query'],
    additionalProperties: false,
  },
};
const closedEmptyTool: ServerToolInfo = {
  name: 'closed_empty',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
};
const prototypeInputTool: ServerToolInfo = {
  name: 'prototype_input',
  inputSchema: JSON.parse(
    '{"type":"object","properties":{"__proto__":{"type":"string"}},"required":["__proto__"],"additionalProperties":false}'
  ),
};
const closedComposedTool: ServerToolInfo = {
  ...closedNamedTool,
  name: 'closed_composed',
  inputSchema: { ...(closedNamedTool.inputSchema as Record<string, unknown>), allOf: [{}] },
};
const chromeTools = [
  clickTool,
  listPagesTool,
  evaluateScriptTool,
  fetchTool,
  searchTool,
  dynamicTool,
  nullableTool,
  openNamedTool,
  closedNamedTool,
  closedEmptyTool,
  closedComposedTool,
  prototypeInputTool,
];

const chromeDefinition: ServerDefinition = {
  name: 'chrome',
  command: { kind: 'http', url: new URL('https://example.com/chrome') },
};

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));

interface EmittedClient {
  clientPath: string;
  clientSource: string;
  typesPath: string;
  typesSource: string;
}

async function emitChromeClient(extraArgs: string[] = []): Promise<EmittedClient> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'emit-ts-object-args-'));
  const clientPath = path.join(tmpDir, 'chrome-client.ts');
  const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  let typesPath = path.join(tmpDir, 'chrome-client.d.ts');
  try {
    await handleEmitTs(createRuntimeStub(chromeTools, chromeDefinition), [
      'chrome',
      '--out',
      clientPath,
      '--mode',
      'client',
      '--json',
      ...extraArgs,
    ]);
    const payload = JSON.parse(logSpy.mock.calls.at(-1)?.[0] ?? '{}') as { typesOutPath: string };
    typesPath = payload.typesOutPath;
  } finally {
    logSpy.mockRestore();
  }
  return {
    clientPath,
    clientSource: await fs.readFile(clientPath, 'utf8'),
    typesPath,
    typesSource: await fs.readFile(typesPath, 'utf8'),
  };
}

// The emitted module imports the published package name; this resolves it to the checkout's own
// proxy implementation and refuses any runtime the client did not receive from its caller.
function requireMcporterShim(specifier: string): {
  createRuntime: () => Promise<never>;
  createServerProxy: typeof createServerProxy;
  wrapCallResult: typeof wrapCallResult;
} {
  if (specifier !== 'mcporter') {
    throw new Error(`Unexpected import '${specifier}' in emitted client.`);
  }
  return {
    createRuntime: async () => {
      throw new Error('The emitted client must reuse the runtime it was given.');
    },
    createServerProxy,
    wrapCallResult,
  };
}

// Runs the emitted client module in-process, so the assertion sits on the arguments the runtime
// hands to `tools/call` rather than on the rendered source text.
async function loadEmittedClient(
  clientSource: string,
  runtime: Runtime,
  factoryName = 'createChromeClient'
): Promise<Record<string, Function>> {
  const { outputText } = ts.transpileModule(clientSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exportsObject: Record<string, unknown> = {};
  runInNewContext(outputText, { require: requireMcporterShim, exports: exportsObject });
  const factory = exportsObject[factoryName] as (options: { runtime: Runtime }) => Promise<Record<string, Function>>;
  return factory({ runtime });
}

// The proxy's dynamic tool methods read schemas through `listTools`, so this runtime serves the
// same tools the client was generated from and records what reaches `callTool`.
function createRecordingRuntime(): Runtime & { callTool: ReturnType<typeof vi.fn> } {
  return {
    listServers: () => ['chrome'],
    getDefinitions: () => [chromeDefinition],
    getDefinition: () => chromeDefinition,
    registerDefinition: () => {},
    listTools: async () => chromeTools,
    callTool: vi.fn(async () => ({ content: [{ type: 'text', text: 'ok' }] })),
    listResources: async () => ({}),
    connect: async () => {
      throw new Error('not implemented');
    },
    close: async () => {},
  } as unknown as Runtime & { callTool: ReturnType<typeof vi.fn> };
}

function withoutTimestamp(source: string): string {
  return source.replace(/^\/\/ Generated on .*$/m, '');
}

// The fixture server answers every call with `{ tool, received }`; this reads back `received`.
function received(result: unknown): unknown {
  const parsed = (result as { json<J>(): J | null }).json<{ tool: string; received: unknown }>();
  return parsed?.received;
}

describe('emit-ts object arguments', () => {
  it('keeps server-controlled header and JSDoc text inside comments', () => {
    const tools = buildToolMetadataList(
      [
        {
          name: 'safe_tool',
          description: '*/ } globalThis.docInjected = true; interface Reopened { /*',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
      { onCollision: 'skip' }
    );
    const docs = emitTsTestInternals.buildDocEntries('chrome', tools, false);
    const clientSource = renderClientModule({
      interfaceName: 'ChromeTools',
      docs,
      metadata: { ...testMetadata, generatorLabel: 'mcporter@test\nglobalThis.headerInjected = true;//' },
    });
    const { outputText } = ts.transpileModule(clientSource, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    });
    const sandbox: Record<string, unknown> = { require: requireMcporterShim, exports: {} };
    runInNewContext(outputText, sandbox);
    expect(sandbox.docInjected).toBeUndefined();
    expect(sandbox.headerInjected).toBeUndefined();
    expect(parseDiagnosticsOf(clientSource)).toEqual([]);
  });

  it('declares one object parameter per tool with wire names kept verbatim, in the client and its .d.ts', async () => {
    const { clientSource, typesSource } = await emitChromeClient();

    for (const source of [clientSource, typesSource]) {
      expect(source).toContain(
        'click(params: { pageId: string; uid: string } & Record<string, unknown>): Promise<CallResult>;'
      );
      expect(source).toContain('list_pages(params?: Record<string, unknown>): Promise<CallResult>;');
      expect(source).toContain(
        'evaluate_script(params: { function: string; pageId?: string } & Record<string, unknown>): Promise<CallResult>;'
      );
      expect(source).toContain(
        'fetch(params: { url: string; "content-type"?: string } & Record<string, unknown>): Promise<CallResult>;'
      );
      expect(source).toContain(
        'search(params: { query: string; limit?: number; verbose?: boolean } & Record<string, unknown>): Promise<CallResult>;'
      );
      expect(parseDiagnosticsOf(source)).toEqual([]);
    }
  });

  it('keeps the positional signatures of --mode types unchanged', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'emit-ts-types-mode-'));
    const typesPath = path.join(tmpDir, 'chrome.d.ts');
    await handleEmitTs(createRuntimeStub([clickTool, listPagesTool, searchTool, listCommentsTool], chromeDefinition), [
      'chrome',
      '--out',
      typesPath,
      '--mode',
      'types',
    ]);
    const typesSource = await fs.readFile(typesPath, 'utf8');

    expect(typesSource).toContain('click(pageId: string, uid: string): Promise<CallResult>;');
    expect(typesSource).toContain('list_pages(): Promise<CallResult>;');
    expect(typesSource).toContain('search(query: string, limit?: number, verbose?: boolean): Promise<CallResult>;');
    expect(typesSource).toContain('list_comments(issueId: string, limit?: number): Promise<CommentList>;');
    expect(typesSource).not.toContain('params');
  });

  it('forwards both required arguments of a two-argument tool to tools/call', async () => {
    const { clientSource } = await emitChromeClient();
    const runtime = createRecordingRuntime();
    const client = await loadEmittedClient(clientSource, runtime);

    const result = await client.click?.({ pageId: 'page-1', uid: 'uid-7' });

    expect(runtime.callTool).toHaveBeenCalledTimes(1);
    expect(runtime.callTool).toHaveBeenLastCalledWith('chrome', 'click', { args: { pageId: 'page-1', uid: 'uid-7' } });
    expect((result as { text(): string | null }).text()).toBe('ok');
  });

  it('forwards map arguments when the schema has no declared properties', async () => {
    const { clientSource } = await emitChromeClient();
    const runtime = createRecordingRuntime();
    const client = await loadEmittedClient(clientSource, runtime);
    await client.dynamic?.({ 'custom-key': 'value' });
    expect(runtime.callTool).toHaveBeenLastCalledWith('chrome', 'dynamic', { args: { 'custom-key': 'value' } });
  });

  it('preserves valid positional null values for regenerated transpile-only callers', async () => {
    const { clientSource } = await emitChromeClient();
    const runtime = createRecordingRuntime();
    const client = await loadEmittedClient(clientSource, runtime);
    await client.nullable?.(null);
    expect(runtime.callTool).toHaveBeenLastCalledWith('chrome', 'nullable', { args: { value: null } });
    await client.nullable?.({ value: null });
    expect(runtime.callTool).toHaveBeenLastCalledWith('chrome', 'nullable', { args: { value: null } });
  });

  it('forwards dynamic keys alongside declared properties', async () => {
    const { clientSource } = await emitChromeClient();
    const runtime = createRecordingRuntime();
    const client = await loadEmittedClient(clientSource, runtime);
    await client.open_named?.({ query: 'needle', extra: 'value' });
    expect(runtime.callTool).toHaveBeenLastCalledWith('chrome', 'open_named', {
      args: { query: 'needle', extra: 'value' },
    });
  });

  it('preserves an own __proto__ key and rejects a prototype-initializer literal', async () => {
    const { clientSource } = await emitChromeClient();
    expect(clientSource).toContain('["__proto__"]: string');
    const runtime = createRecordingRuntime();
    const client = await loadEmittedClient(clientSource, runtime);
    const args = { ['__proto__']: 'value' };
    await client.prototype_input?.(args);
    expect(runtime.callTool).toHaveBeenLastCalledWith('chrome', 'prototype_input', { args });
    const passed = runtime.callTool.mock.calls.at(-1)?.[2]?.args;
    expect(Object.hasOwn(passed, '__proto__')).toBe(true);
    await expect(client.prototype_input?.({ __proto__: 'not an own property' })).rejects.toThrow(
      'Missing required arguments: __proto__'
    );
  });

  it('rejects extra keys in named, composed and empty closed-schema client types', async () => {
    const { clientPath, typesPath } = await emitChromeClient();
    const caller = path.join(path.dirname(clientPath), 'closed-schema-caller.ts');
    await fs.writeFile(
      caller,
      `import { createChromeClient } from './chrome-client';
export async function run() {
  const client = await createChromeClient();
  await client.closed_named({ query: 'ok', extra: 'invalid' });
  await client.closed_composed({ query: 'ok', extra: 'invalid' });
  await client.closed_empty({ extra: 'invalid' });
}
`
    );
    const diagnostics = compileUnderRepositoryConfig([clientPath, typesPath, caller]);
    expect(diagnostics.map(({ file, code }) => ({ file, code }))).toEqual([
      { file: 'closed-schema-caller.ts', code: 2353 },
      { file: 'closed-schema-caller.ts', code: 2353 },
      { file: 'closed-schema-caller.ts', code: 2322 },
    ]);
  });

  it('calls a zero-argument tool without an arguments object', async () => {
    const { clientSource } = await emitChromeClient();
    const runtime = createRecordingRuntime();
    const client = await loadEmittedClient(clientSource, runtime);

    await client.list_pages?.();

    expect(clientSource).toContain('async list_pages(params) {');
    expect(runtime.callTool).toHaveBeenLastCalledWith('chrome', 'list_pages', {});
  });

  it('keeps a reserved-word property name on the wire', async () => {
    const { clientSource } = await emitChromeClient();
    const runtime = createRecordingRuntime();
    const client = await loadEmittedClient(clientSource, runtime);

    await client.evaluate_script?.({ function: '() => document.title' });

    expect(runtime.callTool).toHaveBeenLastCalledWith('chrome', 'evaluate_script', {
      args: { function: '() => document.title' },
    });
  });

  it('applies schema defaults without overwriting explicit values', async () => {
    const { clientSource } = await emitChromeClient();
    const runtime = createRecordingRuntime();
    const client = await loadEmittedClient(clientSource, runtime);

    await client.search?.({ query: 'omitted' });
    expect(runtime.callTool).toHaveBeenLastCalledWith('chrome', 'search', {
      args: { query: 'omitted', limit: 10, verbose: false },
    });

    await client.search?.({ query: 'overridden', limit: 3, verbose: true });
    expect(runtime.callTool).toHaveBeenLastCalledWith('chrome', 'search', {
      args: { query: 'overridden', limit: 3, verbose: true },
    });
  });

  it('rejects a call missing a required argument before it reaches the runtime', async () => {
    const { clientSource } = await emitChromeClient();
    const runtime = createRecordingRuntime();
    const client = await loadEmittedClient(clientSource, runtime);

    await expect(client.click?.({ pageId: 'page-1' })).rejects.toThrow('Missing required arguments: uid');
    expect(runtime.callTool).not.toHaveBeenCalled();
  });

  it('writes the declaration file beside the client by default and honours --types-out', async () => {
    const byDefault = await emitChromeClient();
    expect(byDefault.typesPath).toBe(path.join(path.dirname(byDefault.clientPath), 'chrome-client.d.ts'));

    const customTypesPath = path.join(os.tmpdir(), 'emit-ts-custom-types', 'chrome.d.ts');
    const custom = await emitChromeClient(['--types-out', customTypesPath]);
    expect(custom.typesPath).toBe(customTypesPath);
    expect(custom.typesSource).toContain(
      'click(params: { pageId: string; uid: string } & Record<string, unknown>): Promise<CallResult>;'
    );
    // The client declares its own interface, so its source is the same wherever the .d.ts goes.
    expect(withoutTimestamp(custom.clientSource)).toBe(withoutTimestamp(byDefault.clientSource));
  });

  it('compiles the emitted client and a caller under the repository tsconfig', async () => {
    const { clientPath, typesPath } = await emitChromeClient();
    const dir = path.dirname(clientPath);
    const validCallerPath = path.join(dir, 'caller.ts');
    const missingArgumentCallerPath = path.join(dir, 'caller-missing-uid.ts');
    await fs.writeFile(
      validCallerPath,
      [
        "import { type ChromeTools, createChromeClient } from './chrome-client';",
        'export async function run(): Promise<string | null> {',
        '  const client = await createChromeClient({ configPath: "./mcporter.json" });',
        "  const clicked = await client.click({ pageId: 'page-1', uid: 'uid-7' });",
        '  await client.list_pages();',
        '  await client.closed_empty();',
        "  await client.evaluate_script({ function: '() => 1' });",
        "  await client.fetch({ url: 'https://example.com', 'content-type': 'text/html' });",
        "  await client.search({ query: 'defaults fill limit and verbose' });",
        "  await client.dynamic({ 'custom-key': 'value' });",
        "  await client.open_named({ query: 'needle', extra: 'value' });",
        '  const tools: ChromeTools = client;',
        "  await tools.fetch({ url: 'https://example.com' });",
        '  await client.close();',
        '  return clicked.text();',
        '}',
        '',
      ].join('\n'),
      'utf8'
    );
    await fs.writeFile(
      missingArgumentCallerPath,
      [
        "import { createChromeClient } from './chrome-client';",
        'export async function run(): Promise<void> {',
        '  const client = await createChromeClient();',
        "  await client.click({ pageId: 'page-1' });",
        '}',
        '',
      ].join('\n'),
      'utf8'
    );

    const diagnostics = compileUnderRepositoryConfig([
      clientPath,
      typesPath,
      validCallerPath,
      missingArgumentCallerPath,
    ]);

    expect(diagnostics.filter((entry) => entry.file !== path.basename(missingArgumentCallerPath))).toEqual([]);
    const missing = diagnostics.filter((entry) => entry.file === path.basename(missingArgumentCallerPath));
    expect(missing).toHaveLength(1);
    expect(missing[0]?.code).toBe(2345);
    expect(missing[0]?.message).toContain("'uid'");
  });

  it('compiles client wrappers for tools with named and structural output schemas', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'emit-ts-output-schema-'));
    const clientPath = path.join(dir, 'chrome-client.ts');
    try {
      const structuralTool = {
        ...dashedTool,
        name: 'structural',
        outputSchema: { type: 'object', properties: { value: { type: 'string' }, count: { type: 'number' } } },
      };
      await handleEmitTs(createRuntimeStub([dashedTool, structuralTool], chromeDefinition), [
        'chrome',
        '--out',
        clientPath,
        '--mode',
        'client',
      ]);
      expect(compileUnderRepositoryConfig([clientPath, path.join(dir, 'chrome-client.d.ts')])).toEqual([]);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  // Regeneration over a caller written against the 0.13.13 client, whose `.d.ts` declared
  // `search(query: string, ...)` and whose wrapper forwarded that one value to the proxy. The call
  // still reaches the runtime the same way, and the type error names the object to migrate to.
  it('keeps a 0.13.13 positional call working at runtime and points tsc at the documented migration', async () => {
    const { clientPath, clientSource, typesPath } = await emitChromeClient();
    const runtime = createRecordingRuntime();
    const client = await loadEmittedClient(clientSource, runtime);

    // Transpile-only callers: the proxy maps a single positional value to the first schema
    // property, as it did for the 0.13.13 wrapper, so nothing changes on the wire.
    await client.search?.('positional');
    expect(runtime.callTool).toHaveBeenCalledWith('chrome', 'search', {
      args: { query: 'positional', limit: 10, verbose: false },
    });

    const dir = path.dirname(clientPath);
    const positionalCallerPath = path.join(dir, 'caller-0-13-13.ts');
    const migratedCallerPath = path.join(dir, 'caller-migrated.ts');
    await fs.writeFile(positionalCallerPath, searchCallerSource("client.search('positional')"), 'utf8');
    await fs.writeFile(migratedCallerPath, searchCallerSource("client.search({ query: 'positional' })"), 'utf8');

    const diagnostics = compileUnderRepositoryConfig([clientPath, typesPath, positionalCallerPath, migratedCallerPath]);

    // Type-checked callers: one TS2345 per positional call site, naming the object parameter.
    expect(diagnostics.filter((entry) => entry.file !== path.basename(positionalCallerPath))).toEqual([]);
    const positional = diagnostics.filter((entry) => entry.file === path.basename(positionalCallerPath));
    expect(positional).toHaveLength(1);
    expect(positional[0]?.code).toBe(2345);
    expect(positional[0]?.message).toContain(
      "Argument of type 'string' is not assignable to parameter of type '{ query: string;"
    );
  });
});

// A caller that makes one `search` call, spelled the 0.13.13 way or the documented way.
function searchCallerSource(call: string): string {
  return [
    "import { createChromeClient } from './chrome-client';",
    'export async function run(): Promise<string | null> {',
    '  const client = await createChromeClient();',
    `  const result = await ${call};`,
    '  await client.close();',
    '  return result.text();',
    '}',
    '',
  ].join('\n');
}

interface EmittedDiagnostic {
  file: string | undefined;
  code: number;
  message: string;
}

// Type-checks emitted files and callers under the repository `tsconfig.json`, with the published
// package name resolved to this checkout's `src/index.ts`. Pass the sibling `.d.ts` too: a consumer
// that includes the output directory compiles it alongside the client, and the two must not conflict.
function compileUnderRepositoryConfig(rootNames: string[]): EmittedDiagnostic[] {
  const configPath = path.join(REPO_ROOT, 'tsconfig.json');
  const configFile = ts.readConfigFile(configPath, (file) => ts.sys.readFile(file));
  expect(configFile.error).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, REPO_ROOT, undefined, configPath);
  const options: ts.CompilerOptions = { ...parsed.options, noEmit: true };
  const host = ts.createCompilerHost(options);
  // pnpm test builds these declarations first; exercise the public package surface once per program.
  const packageEntry = path.join(REPO_ROOT, 'dist', 'index.d.ts');
  expect(ts.sys.fileExists(packageEntry), 'Run pnpm build before compiler integration tests').toBe(true);
  host.resolveModuleNameLiterals = (literals, containingFile, _redirected, compilerOptions) =>
    literals.map((literal) =>
      literal.text === 'mcporter'
        ? {
            resolvedModule: {
              resolvedFileName: packageEntry,
              extension: ts.Extension.Dts,
              isExternalLibraryImport: true,
            },
          }
        : ts.resolveModuleName(literal.text, containingFile, compilerOptions, host)
    );
  const program = ts.createProgram(rootNames, options, host);
  return ts.getPreEmitDiagnostics(program).map((entry) => ({
    file: entry.file ? path.basename(entry.file.fileName) : undefined,
    code: entry.code,
    message: ts.flattenDiagnosticMessageText(entry.messageText, '\n'),
  }));
}

// The recording-runtime cases pin what the client hands to the runtime. This one goes the whole
// way: the client is emitted from a real runtime's tool listing over stdio, then calls the same
// server through the real proxy and transport. The fixture answers with the arguments it received.
const realServerTest = process.platform === 'win32' ? it.skip : it;

describe('emit-ts client against a stdio MCP server', () => {
  const fixtureServerScript = fileURLToPath(new URL('./fixtures/stdio-emit-ts-server.mjs', import.meta.url));

  realServerTest(
    'emits a client from the live tool listing and the server receives every argument',
    async () => {
      const runtime = await createRuntime({
        servers: [
          {
            name: 'fixture',
            command: { kind: 'stdio', command: process.execPath, args: [fixtureServerScript], cwd: process.cwd() },
          },
        ],
      });
      try {
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'emit-ts-stdio-'));
        const clientPath = path.join(tmpDir, 'fixture-client.ts');
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        try {
          await handleEmitTs(runtime, ['fixture', '--out', clientPath, '--mode', 'client']);
        } finally {
          logSpy.mockRestore();
        }
        const clientSource = await fs.readFile(clientPath, 'utf8');
        expect(clientSource).toContain(
          'click(params: { pageId: string; uid: string } & Record<string, unknown>): Promise<CallResult>;'
        );
        expect(clientSource).toContain(
          'evaluate_script(params: { function: string; pageId?: string } & Record<string, unknown>): Promise<CallResult>;'
        );
        const client = await loadEmittedClient(clientSource, runtime, 'createFixtureClient');

        expect(received(await client.click?.({ pageId: 'page-1', uid: 'uid-7' }))).toEqual({
          pageId: 'page-1',
          uid: 'uid-7',
        });
        expect(received(await client.search?.({ query: 'omitted' }))).toEqual({
          query: 'omitted',
          limit: 10,
          verbose: false,
        });
        expect(received(await client.search?.({ query: 'overridden', limit: 3, verbose: true }))).toEqual({
          query: 'overridden',
          limit: 3,
          verbose: true,
        });
        expect(received(await client.list_pages?.())).toEqual({});
        expect(received(await client.evaluate_script?.({ function: '() => document.title' }))).toEqual({
          function: '() => document.title',
        });
        await expect(client.click?.({ pageId: 'page-1' })).rejects.toThrow('Missing required arguments: uid');
      } finally {
        await runtime.close('fixture');
      }
    },
    budget(20_000)
  );
});
