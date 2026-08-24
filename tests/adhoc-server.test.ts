import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { persistEphemeralServer, resolveEphemeralServer, splitCommandLine } from '../src/cli/adhoc-server.js';

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

  it('builds complete named HTTPS and stdio definitions', () => {
    const http = resolveEphemeralServer({
      name: 'My Service',
      httpUrl: 'https://www.example.com/mcp/',
      description: 'Example',
      env: { TOKEN: 'value' },
      headers: { 'X-Test': 'yes' },
    });
    expect(http).toMatchObject({
      name: 'my-service',
      definition: { name: 'my-service', description: 'Example', env: { TOKEN: 'value' } },
      persistedEntry: {
        baseUrl: 'https://www.example.com/mcp/',
        description: 'Example',
        env: { TOKEN: 'value' },
        headers: { 'X-Test': 'yes' },
      },
    });

    const stdio = resolveEphemeralServer({
      name: 'Local Tool',
      stdioCommand: `node 'server file.js'`,
      stdioArgs: ['--stdio'],
      cwd: '.',
      description: 'Local',
      env: { MODE: 'test' },
    });
    expect(stdio.definition.command).toMatchObject({
      kind: 'stdio',
      command: 'node',
      args: ['server file.js', '--stdio'],
      cwd: process.cwd(),
    });
    expect(stdio.persistedEntry).toMatchObject({
      command: 'node',
      args: ['server file.js', '--stdio'],
      cwd: '.',
      description: 'Local',
      env: { MODE: 'test' },
    });
  });

  it('rejects ambiguous, insecure, unsupported, empty, and invalidly named servers', () => {
    expect(() => resolveEphemeralServer({})).toThrow('require either --http-url or --stdio');
    expect(() => resolveEphemeralServer({ httpUrl: 'https://example.com', stdioCommand: 'node' })).toThrow(
      'Cannot combine'
    );
    expect(() => resolveEphemeralServer({ httpUrl: 'http://example.com' })).toThrow('require --allow-http');
    expect(() => resolveEphemeralServer({ httpUrl: 'ftp://example.com' })).toThrow("Unsupported protocol 'ftp:'");
    expect(() => resolveEphemeralServer({ stdioCommand: '   ' })).toThrow('requires a non-empty command');
    expect(() => resolveEphemeralServer({ name: '---', stdioCommand: 'node' })).toThrow('at least one letter or digit');
  });

  it('infers executable, script, and fallback names and parses shell quoting', () => {
    expect(resolveEphemeralServer({ stdioCommand: '/usr/local/bin/demo' }).name).toBe('demo');
    expect(resolveEphemeralServer({ stdioCommand: 'node ./servers/demo.ts' }).name).toBe('node-demo');
    expect(resolveEphemeralServer({ stdioCommand: 'runner serve' }).name).toBe('runner-serve');
    expect(splitCommandLine(`node "a b.js" 'single value' plain\\ value "keep\\n"`)).toEqual([
      'node',
      'a b.js',
      'single value',
      'plain value',
      'keep\\n',
    ]);
    expect(() => splitCommandLine(`node 'unterminated`)).toThrow('Unterminated quote');
  });

  it('normalizes long separator runs without changing slug semantics', () => {
    expect(resolveEphemeralServer({ name: `alpha${'-'.repeat(100_000)}beta`, stdioCommand: 'node' }).name).toBe(
      'alpha-beta'
    );
  });

  it('persists into new and existing config containers without dropping unrelated keys', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-adhoc-persist-'));
    const configPath = path.join(dir, 'nested', 'mcporter.json');
    const resolution = resolveEphemeralServer({ name: 'demo', httpUrl: 'https://example.com/mcp' });
    try {
      await persistEphemeralServer(resolution, configPath);
      let config = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
      expect(config).toMatchObject({ mcpServers: { demo: { baseUrl: 'https://example.com/mcp' } } });

      await fs.writeFile(configPath, JSON.stringify({ imports: ['one'], mcpServers: 'invalid' }));
      await persistEphemeralServer(resolution, configPath);
      config = JSON.parse(await fs.readFile(configPath, 'utf8')) as Record<string, unknown>;
      expect(config).toMatchObject({ imports: ['one'], mcpServers: { demo: resolution.persistedEntry } });

      await fs.writeFile(configPath, '{ invalid json');
      await expect(persistEphemeralServer(resolution, configPath)).rejects.toThrow();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
