import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { templateTestHelpers } from '../src/cli/generate/template.js';
import type { ServerDefinition } from '../src/config.js';

const { computeRelativeStdioCwd } = templateTestHelpers;

function stdioDef(overrides: { cwd?: string; command?: string; args?: string[] } = {}): ServerDefinition {
  return {
    name: 'demo',
    command: {
      kind: 'stdio',
      command: overrides.command ?? 'node',
      args: overrides.args ?? ['dist/index.js'],
      ...(overrides.cwd !== undefined ? { cwd: overrides.cwd } : {}),
    },
  } as ServerDefinition;
}

describe('computeRelativeStdioCwd', () => {
  it('returns null when outputPath is missing', () => {
    expect(computeRelativeStdioCwd(stdioDef({ cwd: '/foo/bar' }), undefined)).toBeNull();
  });

  it('returns null for HTTP-backed servers', () => {
    const httpDef: ServerDefinition = {
      name: 'demo',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
    } as ServerDefinition;
    expect(computeRelativeStdioCwd(httpDef, '/pkg/dist/cli.cjs')).toBeNull();
  });

  it('relativizes an explicit cwd against the output directory', () => {
    const def = stdioDef({ cwd: '/pkg' });
    const rel = computeRelativeStdioCwd(def, '/pkg/dist/cli.cjs');
    expect(rel).toBe('..');
  });

  it('resolves to "." when cwd equals the output directory', () => {
    const def = stdioDef({ cwd: '/pkg/dist' });
    expect(computeRelativeStdioCwd(def, '/pkg/dist/cli.cjs')).toBe('.');
  });

  it('falls back to process.cwd() when no cwd is set (ad-hoc --command)', () => {
    const def = stdioDef();
    const rel = computeRelativeStdioCwd(def, path.join(process.cwd(), 'dist', 'cli.cjs'));
    expect(rel).toBe('..');
  });

  it('treats relative cwd inputs as resolved against process.cwd()', () => {
    const def = stdioDef({ cwd: 'relative-dir' });
    const expected = path.relative(path.dirname('/pkg/dist/cli.cjs'), path.resolve(process.cwd(), 'relative-dir'));
    const rel = computeRelativeStdioCwd(def, '/pkg/dist/cli.cjs');
    expect(rel).toBe(expected);
  });
});
