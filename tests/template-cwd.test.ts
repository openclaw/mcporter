import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { templateTestHelpers } from '../src/cli/generate/template.js';
import type { ServerDefinition } from '../src/config.js';

const { computeRelativeStdioCwd } = templateTestHelpers;

function stdioDef(overrides: { cwd?: string; args?: string[] } = {}): ServerDefinition {
  return {
    name: 'demo',
    command: {
      kind: 'stdio',
      command: 'node',
      args: overrides.args ?? ['dist/index.js'],
      ...(overrides.cwd !== undefined ? { cwd: overrides.cwd } : {}),
    },
  } as ServerDefinition;
}

describe('computeRelativeStdioCwd', () => {
  it('returns null when outputPath is missing', () => {
    expect(computeRelativeStdioCwd(stdioDef(), undefined)).toBeNull();
  });

  it('returns null for HTTP-backed servers', () => {
    const httpDef: ServerDefinition = {
      name: 'demo',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
    } as ServerDefinition;
    expect(computeRelativeStdioCwd(httpDef, '/pkg/dist/cli.cjs')).toBeNull();
  });

  it('preserves an explicit absolute cwd from the embedded definition', () => {
    expect(computeRelativeStdioCwd(stdioDef({ cwd: '/pkg' }), '/pkg/dist/cli.cjs')).toBeNull();
  });

  it('relativizes ad-hoc stdio cwd against the final artifact directory', () => {
    const rel = computeRelativeStdioCwd(stdioDef(), path.join(process.cwd(), 'dist', 'cli.cjs'));
    expect(rel).toBe('..');
  });

  it('resolves to "." when relative cwd equals the output directory', () => {
    expect(computeRelativeStdioCwd(stdioDef({ cwd: 'dist' }), path.join(process.cwd(), 'dist', 'cli.cjs'))).toBe('.');
  });

  it('resolves relative cwd inputs against process.cwd()', () => {
    const outputPath = '/pkg/dist/cli.cjs';
    const expected = path.relative(path.dirname(outputPath), path.resolve(process.cwd(), 'relative-dir'));
    expect(computeRelativeStdioCwd(stdioDef({ cwd: 'relative-dir' }), outputPath)).toBe(expected);
  });
});
