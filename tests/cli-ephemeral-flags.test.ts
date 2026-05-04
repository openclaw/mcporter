import { describe, expect, it } from 'vitest';

import { extractEphemeralServerFlags } from '../src/cli/ephemeral-flags.js';

describe('extractEphemeralServerFlags', () => {
  it('parses HTTP URLs, headers, and env overrides', () => {
    const args = [
      '--http-url',
      'https://mcp.example.com/mcp',
      '--env',
      'TOKEN=abc',
      '--header',
      'Authorization=$env:API_TOKEN',
      '--header',
      'X-Tenant=biz=unit',
      'list',
    ];
    const spec = extractEphemeralServerFlags(args);
    expect(spec).toEqual({
      httpUrl: 'https://mcp.example.com/mcp',
      env: { TOKEN: 'abc' },
      headers: { Authorization: '$env:API_TOKEN', 'X-Tenant': 'biz=unit' },
    });
    expect(args).toEqual(['list']);
  });

  it('rejects malformed ad-hoc headers', () => {
    expect(() =>
      extractEphemeralServerFlags(['--http-url', 'https://mcp.example.com/mcp', '--header', 'oops'])
    ).toThrow("Flag '--header' requires KEY=value.");
  });

  it('captures stdio commands and additional args', () => {
    const args = ['--stdio', 'bun run ./server.ts', '--stdio-arg', '--watch', 'call'];
    const spec = extractEphemeralServerFlags(args);
    expect(spec).toEqual({ stdioCommand: 'bun run ./server.ts', stdioArgs: ['--watch'] });
    expect(args).toEqual(['call']);
  });

  it('records name/description/persist metadata', () => {
    const args = [
      '--http-url',
      'https://mcp.example.com/mcp',
      '--name',
      'example',
      '--description',
      'Test',
      '--persist',
      'config.json',
    ];
    const spec = extractEphemeralServerFlags(args);
    expect(spec).toEqual({
      httpUrl: 'https://mcp.example.com/mcp',
      name: 'example',
      description: 'Test',
      persistPath: 'config.json',
    });
    expect(args).toEqual([]);
  });

  it('accepts --insecure as a hidden alias for --allow-http', () => {
    const args = ['--http-url', 'http://mcp.example.com/mcp', '--insecure'];
    const spec = extractEphemeralServerFlags(args);
    expect(spec).toEqual({ httpUrl: 'http://mcp.example.com/mcp', allowInsecureHttp: true });
    expect(args).toEqual([]);
  });

  it('accepts --sse as a hidden alias for --http-url', () => {
    const args = ['--sse', 'https://mcp.example.com/sse'];
    const spec = extractEphemeralServerFlags(args);
    expect(spec).toEqual({ httpUrl: 'https://mcp.example.com/sse' });
    expect(args).toEqual([]);
  });
});
