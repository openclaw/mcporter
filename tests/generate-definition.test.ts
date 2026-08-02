import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeDefinition, resolveServerDefinition } from '../src/cli/generate/definition.js';
import { serializeDefinition } from '../src/cli-metadata.js';

const FIXTURE_CONFIG = path.resolve(__dirname, 'fixtures', 'mcporter.json');

describe('resolveServerDefinition HTTP selectors', () => {
  it('resolves configured servers by HTTPS URL', async () => {
    const { name } = await resolveServerDefinition('https://www.shadcn.io/api/mcp', FIXTURE_CONFIG);
    expect(name).toBe('shadcn');
  });

  it('resolves configured servers by scheme-less selectors with tool suffixes', async () => {
    const { name } = await resolveServerDefinition('shadcn.io/api/mcp.getComponent', FIXTURE_CONFIG);
    expect(name).toBe('shadcn');
  });

  it('treats raw HTTPS paths without scheme as stdio commands in inline definitions', async () => {
    const inline = JSON.stringify({ name: 'context7-inline', command: 'mcp.context7.com/mcp' });
    const { definition, name } = await resolveServerDefinition(inline);
    expect(name).toBe('context7-inline');
    expect(definition.command.kind).toBe('stdio');
    expect((definition.command as { command: string }).command).toBe('mcp.context7.com/mcp');
  });

  it('preserves a config-file protocol version pin in generated definitions', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-generate-definition-'));
    const configPath = path.join(tempDir, 'mcporter.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          modern: {
            command: 'https://modern.example.com/mcp',
            protocolVersion: '2026-07-28',
          },
        },
      })
    );

    try {
      const { definition } = await resolveServerDefinition(configPath);
      expect(definition.protocolVersion).toBe('2026-07-28');
      expect(serializeDefinition(definition).protocolVersion).toBe('2026-07-28');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves a snake-case protocol version pin in inline generated definitions', async () => {
    const inline = JSON.stringify({
      name: 'modern-inline',
      command: 'https://modern.example.com/mcp',
      protocol_version: '2026-07-28',
    });

    const { definition } = await resolveServerDefinition(inline);
    expect(definition.protocolVersion).toBe('2026-07-28');
    expect(serializeDefinition(definition).protocolVersion).toBe('2026-07-28');
  });
});

describe('normalizeDefinition', () => {
  it('normalizes the complete supported HTTP shape and snake-case aliases', () => {
    const definition = normalizeDefinition({
      name: 'complete',
      description: 'Complete definition',
      command: { kind: 'http', url: 'https://example.com/mcp', headers: { Existing: 'one' } },
      headers: { Existing: 'overridden', Added: 'two' },
      env: { VALID: 'yes', INVALID: 42 },
      auth: 'oauth',
      token_cache_dir: '/tmp/tokens',
      client_name: 'client',
      protocol_version: 'legacy',
      oauth_client_id: 'id',
      oauth_client_secret: 'secret',
      oauth_client_secret_env: 'SECRET_ENV',
      oauth_token_endpoint_auth_method: 'client_secret_post',
      oauth_redirect_url: 'http://localhost/callback',
      oauth_client_metadata_url: 'https://example.com/client.json',
      oauth_scope: 'read',
      oauth_command: { args: ['--profile', 'test', 42] },
      refresh: {
        token_endpoint: 'https://example.com/token',
        client_id_env: 'CLIENT_ID',
        client_secret_env: 'CLIENT_SECRET',
        client_auth_method: 'basic',
        refresh_skew_seconds: 30,
        access_token_env: 'ACCESS_TOKEN',
      },
      http_fetch: 'node-http1',
      lifecycle: { mode: 'keep-alive', idleTimeoutMs: 500 },
      logging: { daemon: { enabled: true } },
      allowed_tools: ['read', 'write'],
    });

    expect(definition).toMatchObject({
      name: 'complete',
      description: 'Complete definition',
      command: {
        kind: 'http',
        url: new URL('https://example.com/mcp'),
        headers: { Existing: 'overridden', Added: 'two' },
      },
      env: { VALID: 'yes' },
      auth: 'oauth',
      tokenCacheDir: '/tmp/tokens',
      clientName: 'client',
      protocolVersion: 'legacy',
      oauthClientId: 'id',
      oauthClientSecret: 'secret',
      oauthClientSecretEnv: 'SECRET_ENV',
      oauthTokenEndpointAuthMethod: 'client_secret_post',
      oauthRedirectUrl: 'http://localhost/callback',
      oauthClientMetadataUrl: 'https://example.com/client.json',
      oauthScope: 'read',
      oauthCommand: { args: ['--profile', 'test'] },
      refresh: {
        tokenEndpoint: 'https://example.com/token',
        clientIdEnv: 'CLIENT_ID',
        clientSecretEnv: 'CLIENT_SECRET',
        clientAuthMethod: 'basic',
        refreshSkewSeconds: 30,
        accessTokenEnv: 'ACCESS_TOKEN',
      },
      httpFetch: 'node-http1',
      lifecycle: { mode: 'keep-alive', idleTimeoutMs: 500 },
      logging: { daemon: { enabled: true } },
      allowedTools: ['read', 'write'],
    });
  });

  it('normalizes stdio object, command-array, and string forms', () => {
    const object = normalizeDefinition({
      name: 'object',
      command: { kind: 'stdio', command: 'node', args: ['server.js'], cwd: undefined },
      lifecycle: 'ephemeral',
      blockedTools: [],
    });
    const array = normalizeDefinition({ name: 'array', command: ['bun', 'run', 'server.ts'] });
    const string = normalizeDefinition({ name: 'string', command: 'node', args: ['server.js', 42] });

    expect(object.command).toEqual({ kind: 'stdio', command: 'node', args: ['server.js'], cwd: process.cwd() });
    expect(object.lifecycle).toEqual({ mode: 'ephemeral' });
    expect(object.blockedTools).toEqual([]);
    expect(array.command).toEqual({ kind: 'stdio', command: 'bun', args: ['run', 'server.ts'], cwd: process.cwd() });
    expect(string.command).toEqual({ kind: 'stdio', command: 'node', args: ['server.js'], cwd: process.cwd() });
  });

  it('rejects malformed definitions instead of silently weakening policy', () => {
    expect(() => normalizeDefinition({ name: '', command: 'node' })).toThrow('must include a name');
    expect(() => normalizeDefinition({ name: 'missing' })).toThrow('must include command information');
    expect(() => normalizeDefinition({ name: 'array', command: ['node', 42] })).toThrow(
      'Command array must contain only strings'
    );
    expect(() => normalizeDefinition({ name: 'allowed', command: 'node', allowedTools: 'read' })).toThrow(
      'allowedTools must be an array of strings'
    );
    expect(() => normalizeDefinition({ name: 'blocked', command: 'node', blockedTools: ['read', 42] })).toThrow(
      'blockedTools must be an array of strings'
    );
    expect(() =>
      normalizeDefinition({ name: 'conflict', command: 'node', allowedTools: ['read'], blockedTools: ['write'] })
    ).toThrow('cannot specify both allowedTools and blockedTools');
  });

  it('ignores malformed optional metadata while retaining valid empty logging configuration', () => {
    const definition = normalizeDefinition({
      name: 'minimal',
      command: 'https://example.com/mcp',
      protocolVersion: 'future',
      httpFetch: 'custom',
      refresh: { tokenEndpoint: '', refreshSkewSeconds: -1 },
      oauthCommand: { args: [42] },
      lifecycle: { mode: 'unknown' },
      logging: { daemon: { enabled: 'yes' } },
    });

    expect(definition.command.kind).toBe('http');
    expect(definition.protocolVersion).toBeUndefined();
    expect(definition.httpFetch).toBeUndefined();
    expect(definition.refresh).toBeUndefined();
    expect(definition.oauthCommand).toBeUndefined();
    expect(definition.logging).toEqual({ daemon: {} });
  });
});
