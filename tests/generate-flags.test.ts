import { describe, expect, it } from 'vitest';
import { parseGenerateFlags } from '../src/cli/generate/flags.js';

describe('generate-cli flag parsing', () => {
  it('parses the complete artifact request and deduplicates repeated tool filters', () => {
    const args = [
      '--server',
      'linear',
      '--name',
      'linear-cli',
      '--description',
      'Issue tools',
      '--output',
      'dist/linear.ts',
      '--bundler',
      'rolldown',
      '--bundle',
      'dist/linear.js',
      '--compile',
      'dist/linear',
      '--minify',
      '--from',
      'old-cli',
      '--dry-run',
      '--include-tools',
      'list, create',
      '--include-tools',
      'create,update',
      '--exclude-tools',
      'admin, debug',
    ];

    expect(parseGenerateFlags(args)).toMatchObject({
      server: 'linear',
      name: 'linear-cli',
      description: 'Issue tools',
      output: 'dist/linear.ts',
      bundler: 'rolldown',
      bundle: 'dist/linear.js',
      compile: 'dist/linear',
      minify: true,
      from: 'old-cli',
      dryRun: true,
      includeTools: ['list', 'create', 'update'],
      excludeTools: ['admin', 'debug'],
      timeout: 30_000,
    });
    expect(args).toEqual([]);
  });

  it('supports boolean bundle and compile flags and explicit no-minify', () => {
    const args = ['--bundle', '--compile', '--no-minify', '--runtime', 'bun', '--timeout', '4500', 'linear'];
    expect(parseGenerateFlags(args)).toMatchObject({
      server: 'linear',
      bundle: true,
      compile: true,
      minify: false,
      runtime: 'bun',
      timeout: 4500,
    });
    expect(args).toEqual([]);
  });

  it('normalizes inline commands and strips HTTP tool selectors', () => {
    expect(parseGenerateFlags(['--command', 'node "server file.mjs" --stdio']).command).toEqual({
      command: 'node',
      args: ['server file.mjs', '--stdio'],
    });
    expect(parseGenerateFlags(['--command', 'https://example.com/mcp.search']).command).toBe('https://example.com/mcp');
    expect(parseGenerateFlags(['npx -y @acme/search-mcp']).command).toEqual({
      command: 'npx',
      args: ['-y', '@acme/search-mcp'],
    });
  });

  it('rejects invalid bundlers and unknown generate-cli flags', () => {
    expect(() => parseGenerateFlags(['--bundler', 'webpack'])).toThrow("--bundler must be 'rolldown' or 'bun'");
    expect(() => parseGenerateFlags(['--mystery'])).toThrow("Unknown flag '--mystery' for generate-cli");
  });
});
