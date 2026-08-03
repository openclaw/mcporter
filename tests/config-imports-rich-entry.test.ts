import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readExternalEntries } from '../src/config-imports.js';

describe('rich external config imports', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-import-rich-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('preserves supported OAuth, refresh, protocol, and command-array fields', async () => {
    const configPath = path.join(tempDir, 'mcp.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          rich: {
            description: 'Rich import',
            command: ['node', 'server.js'],
            args: ['ignored-by-array-but-preserved'],
            env: { PORT: 3000, ENABLED: true, OMIT: null },
            headers: { 'X-Number': 42 },
            bearer_token_env: 'TOKEN_ENV',
            auth: 'oauth',
            token_cache_dir: '/tmp/tokens',
            client_name: 'client',
            protocol_version: 'legacy',
            oauth_client_id: 'id',
            oauth_client_secret: 'secret',
            oauth_client_secret_env: 'SECRET_ENV',
            oauth_token_endpoint_auth_method: 'client_secret_post',
            oauth_client_metadata_url: 'https://example.com/client.json',
            http_fetch: 'node-http1',
            refresh: {
              token_endpoint: 'https://example.com/token',
              client_id_env: 'CLIENT_ID',
              refresh_skew_seconds: 30,
            },
          },
          primitive: 42,
          targetless: { description: 'not a server' },
        },
        servers: {
          rich: { command: 'must-not-win' },
        },
      })
    );

    const entries = await readExternalEntries(configPath);

    expect(entries?.size).toBe(1);
    expect(entries?.get('rich')).toMatchObject({
      description: 'Rich import',
      command: ['node', 'server.js'],
      args: ['ignored-by-array-but-preserved'],
      env: { PORT: '3000', ENABLED: 'true' },
      headers: { 'X-Number': '42', Authorization: '$env:TOKEN_ENV' },
      auth: 'oauth',
      tokenCacheDir: '/tmp/tokens',
      clientName: 'client',
      protocolVersion: 'legacy',
      oauthClientId: 'id',
      oauthClientSecret: 'secret',
      oauthClientSecretEnv: 'SECRET_ENV',
      oauthTokenEndpointAuthMethod: 'client_secret_post',
      oauthClientMetadataUrl: 'https://example.com/client.json',
      httpFetch: 'node-http1',
      refresh: {
        tokenEndpoint: 'https://example.com/token',
        clientIdEnv: 'CLIENT_ID',
        refreshSkewSeconds: 30,
      },
    });
  });

  it('returns empty maps for non-object JSON and TOML without mcp_servers', async () => {
    const jsonPath = path.join(tempDir, 'array.json');
    const tomlPath = path.join(tempDir, 'empty.toml');
    await fs.writeFile(jsonPath, '[]');
    await fs.writeFile(tomlPath, 'title = "not an MCP config"');

    await expect(readExternalEntries(jsonPath)).resolves.toEqual(new Map());
    await expect(readExternalEntries(tomlPath)).resolves.toEqual(new Map());
  });

  it('returns null when the import path does not exist', async () => {
    await expect(readExternalEntries(path.join(tempDir, 'missing.json'))).resolves.toBeNull();
  });
});
