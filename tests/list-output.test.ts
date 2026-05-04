import { describe, expect, it, vi } from 'vitest';
import { buildToolMetadata } from '../src/cli/generate/tools.js';
import type { ListSummaryResult } from '../src/cli/list-format.js';
import {
  buildAuthCommandHint,
  buildJsonListEntry,
  createEmptyStatusCounts,
  printBriefTool,
  printSingleServerHeader,
  printToolDetail,
} from '../src/cli/list-output.js';
import type { ServerDefinition } from '../src/config.js';
import type { ServerToolInfo } from '../src/runtime.js';

describe('list output helpers', () => {
  const definition: ServerDefinition = {
    name: 'demo',
    description: 'Demo server',
    command: { kind: 'http', url: new URL('https://demo.example.com/mcp') },
    source: { kind: 'local', path: '/tmp/mcporter.json' },
  };

  it('renders single server headers with tool counts and transport info', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const summary = printSingleServerHeader(definition, 2, 42, 'HTTP https://demo.example.com/mcp', 'config/demo');
    expect(summary).toContain('2 tools');
    expect(summary).toContain('42ms');
    expect(summary).toContain('HTTP https://demo.example.com/mcp');
    logSpy.mockRestore();
  });

  it('prints tool details and indicates optional fields', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const tool: ServerToolInfo = {
      name: 'add',
      description: 'Add numbers',
      inputSchema: {
        type: 'object',
        properties: {
          a: { type: 'number', description: 'First operand' },
          b: { type: 'number', description: 'Second operand' },
          format: { type: 'string', enum: ['json', 'markdown'], description: 'Format' },
          projectId: { type: 'string', description: 'Project context' },
          initiativeId: { type: 'string', description: 'Initiative context' },
          creatorId: { type: 'string', description: 'Creator filter' },
        },
        required: ['a', 'b'],
      },
      outputSchema: { type: 'number' },
    };
    const metadata = buildToolMetadata(tool);
    const detail = printToolDetail(definition, metadata, true, true);
    expect(detail.optionalOmitted).toBe(true);
    expect(detail.examples.length).toBeGreaterThan(0);
    logSpy.mockRestore();
  });

  it('prints brief tool signatures without examples or doc comments', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const tool: ServerToolInfo = {
      name: 'add',
      description: 'Add numbers',
      inputSchema: {
        type: 'object',
        properties: {
          a: { type: 'number', description: 'First operand' },
          b: { type: 'number', description: 'Second operand' },
          format: { type: 'string', enum: ['json', 'markdown'], description: 'Format' },
          projectId: { type: 'string', description: 'Project context' },
          initiativeId: { type: 'string', description: 'Initiative context' },
          creatorId: { type: 'string', description: 'Creator filter' },
        },
        required: ['a', 'b'],
      },
      outputSchema: { type: 'number' },
    };
    const metadata = buildToolMetadata(tool);
    const detail = printBriefTool(definition, metadata, true);
    const lines = logSpy.mock.calls.map((call) => call.join(' '));
    expect(lines.some((line) => line.includes('function add('))).toBe(true);
    expect(lines.some((line) => line.includes('@param a'))).toBe(false);
    expect(lines.some((line) => line.includes('Examples:'))).toBe(false);
    expect(detail.optionalOmitted).toBe(true);
    logSpy.mockRestore();
  });

  it('prints URL-based examples for ad-hoc HTTP servers', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const adhocDefinition: ServerDefinition = {
      name: 'mcp-sentry-dev-mcp',
      description: 'Ad-hoc Sentry',
      command: { kind: 'http', url: new URL('https://mcp.sentry.dev/mcp?agent=1') },
      source: { kind: 'local', path: '<adhoc>' },
    };
    const tool: ServerToolInfo = {
      name: 'use_sentry',
      description: 'Proxy to Sentry',
      inputSchema: {
        type: 'object',
        properties: {
          request: { type: 'string', description: 'Instruction' },
        },
        required: ['request'],
      },
      outputSchema: { type: 'object' },
    };
    const metadata = buildToolMetadata(tool);
    const detail = printToolDetail(adhocDefinition, metadata, false, true);
    expect(detail.examples[0]).toContain("'https://mcp.sentry.dev/mcp?agent=1.use_sentry(");
    logSpy.mockRestore();
  });

  it('builds JSON summaries for successful servers', () => {
    const summary: ListSummaryResult = {
      status: 'ok',
      server: definition,
      durationMs: 12,
      tools: [
        { name: 'add', description: 'Add numbers', inputSchema: { type: 'object' }, outputSchema: { type: 'number' } },
      ],
    };
    const entry = buildJsonListEntry(summary, 30, { includeSchemas: true });
    expect(entry.status).toBe('ok');
    expect(entry.tools?.[0]?.name).toBe('add');
    expect(entry.tools?.[0]?.inputSchema).toBeDefined();
  });

  it('includes auth hints for error summaries', () => {
    const summary: ListSummaryResult = {
      status: 'error',
      server: definition,
      durationMs: 1000,
      error: new Error('HTTP error 401'),
    };
    const entry = buildJsonListEntry(summary, 5, { includeSchemas: false });
    expect(entry.status).toBe('auth');
    expect(entry.authCommand).toBe(buildAuthCommandHint(definition));
  });

  it('exposes source list in JSON only when includeSources is true', () => {
    const withSources: ServerDefinition = {
      ...definition,
      source: { kind: 'local', path: '/project/config/mcporter.json' },
      sources: [
        { kind: 'local', path: '/project/config/mcporter.json' },
        { kind: 'import', path: '/home/.cursor/mcp.json' },
      ],
    };
    const summary: ListSummaryResult = {
      status: 'ok',
      server: withSources,
      durationMs: 10,
      tools: [],
    };

    const minimal = buildJsonListEntry(summary, 30, { includeSchemas: false });
    expect(minimal.sources).toBeUndefined();

    const verbose = buildJsonListEntry(summary, 30, { includeSchemas: false, includeSources: true });
    expect(verbose.sources).toEqual(withSources.sources);
    expect(verbose.source).toEqual(withSources.source);
  });

  it('creates empty status counts with zeroed categories', () => {
    const counts = createEmptyStatusCounts();
    expect(counts).toEqual({ ok: 0, auth: 0, offline: 0, http: 0, error: 0 });
  });
});
