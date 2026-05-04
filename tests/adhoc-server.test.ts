import { describe, expect, it } from 'vitest';
import { resolveEphemeralServer } from '../src/cli/adhoc-server.js';

describe('resolveEphemeralServer', () => {
  it('injects Accept header for HTTP definitions', () => {
    const { definition } = resolveEphemeralServer({ httpUrl: 'https://example.com/mcp' });
    expect(definition.command.kind).toBe('http');
    const headers = definition.command.kind === 'http' ? definition.command.headers : undefined;
    expect(headers?.accept?.toLowerCase()).toContain('application/json');
    expect(headers?.accept?.toLowerCase()).toContain('text/event-stream');
  });

  it('preserves ad-hoc HTTP headers in runtime and persisted definitions', () => {
    const { definition, persistedEntry } = resolveEphemeralServer({
      httpUrl: 'https://example.com/mcp',
      headers: {
        Authorization: '$env:API_TOKEN',
        'X-Tenant': 'biz-unit-01',
      },
    });
    expect(definition.command.kind).toBe('http');
    const headers = definition.command.kind === 'http' ? definition.command.headers : undefined;
    expect(headers).toMatchObject({
      Authorization: '$env:API_TOKEN',
      'X-Tenant': 'biz-unit-01',
    });
    expect(headers?.accept?.toLowerCase()).toContain('application/json');
    expect(headers?.accept?.toLowerCase()).toContain('text/event-stream');
    expect(persistedEntry.headers).toEqual({
      Authorization: '$env:API_TOKEN',
      'X-Tenant': 'biz-unit-01',
    });
  });

  it('auto-enables keep-alive for STDIO commands that match known signatures', () => {
    const { definition, persistedEntry } = resolveEphemeralServer({
      stdioCommand: 'npx -y chrome-devtools-mcp@latest',
    });
    expect(definition.name).toBe('chrome-devtools');
    expect(definition.lifecycle?.mode).toBe('keep-alive');
    expect(persistedEntry.lifecycle).toBe('keep-alive');
  });

  it('infers package names instead of wrapper flags for npx workflows', () => {
    const { definition } = resolveEphemeralServer({
      stdioCommand: 'npx -y xcodebuildmcp',
    });
    expect(definition.name).toBe('xcodebuildmcp');
  });

  it('drops versions when inferring scoped npm package names', () => {
    const { definition } = resolveEphemeralServer({
      stdioCommand: 'npx -y @scope/example-mcp@latest',
    });
    expect(definition.name).toBe('scope-example-mcp');
  });

  it('ignores additional positional args after double-dash when inferring package names', () => {
    const { definition } = resolveEphemeralServer({
      stdioCommand: 'npx -y @scope/xcodebuildmcp@canary -- --port 1234',
    });
    expect(definition.name).toBe('scope-xcodebuildmcp');
  });

  it('normalizes mixed-case package tokens and --yes flag variants', () => {
    const { definition } = resolveEphemeralServer({
      stdioCommand: 'npx --yes XcodeBuildMCP@1.2.3 doctor',
    });
    expect(definition.name).toBe('xcodebuildmcp');
  });
});
