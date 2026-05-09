import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadServerDefinitions } from '../src/config.js';

const TEMP_DIR = path.join(os.tmpdir(), 'mcporter-config-test');

describe('config normalization', () => {
  it('injects Accept header for HTTP servers', async () => {
    await fs.mkdir(TEMP_DIR, { recursive: true });
    const configPath = path.join(TEMP_DIR, 'mcporter.json');
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            test: {
              baseUrl: 'https://example.com/mcp',
            },
          },
        },
        null,
        2
      ),
      'utf8'
    );

    const servers = await loadServerDefinitions({ configPath });
    const server = servers.find((entry) => entry.name === 'test');
    expect(server).toBeDefined();
    expect(server?.command.kind).toBe('http');
    const headers = server?.command.kind === 'http' ? server.command.headers : undefined;
    expect(headers).toBeDefined();
    expect(headers?.accept?.toLowerCase()).toContain('application/json');
    expect(headers?.accept?.toLowerCase()).toContain('text/event-stream');
  });

  it('respects cwd on stdio servers', async () => {
    await fs.mkdir(TEMP_DIR, { recursive: true });
    const configPath = path.join(TEMP_DIR, 'mcporter-cwd.json');
    const absoluteCwd = path.join(os.tmpdir(), 'mcporter-cwd-absolute');
    await fs.mkdir(absoluteCwd, { recursive: true });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            absolute: {
              command: 'node',
              args: ['server.js'],
              cwd: absoluteCwd,
            },
            relative: {
              command: 'node',
              args: ['server.js'],
              cwd: 'packages/foo',
            },
            tilde: {
              command: 'node',
              args: ['server.js'],
              cwd: '~/mcporter-cwd-home',
            },
            tildeBackslash: {
              command: 'node',
              args: ['server.js'],
              cwd: '~\\mcporter-cwd-home',
            },
            defaulted: {
              command: 'node',
              args: ['server.js'],
            },
          },
        },
        null,
        2
      ),
      'utf8'
    );

    const servers = await loadServerDefinitions({ configPath });
    const byName = new Map(servers.map((entry) => [entry.name, entry]));
    const cwdFor = (name: string): string | undefined => {
      const command = byName.get(name)?.command;
      return command?.kind === 'stdio' ? command.cwd : undefined;
    };

    expect(cwdFor('absolute')).toBe(absoluteCwd);
    expect(cwdFor('relative')).toBe(path.resolve(TEMP_DIR, 'packages/foo'));
    expect(cwdFor('tilde')).toBe(path.join(os.homedir(), 'mcporter-cwd-home'));
    expect(cwdFor('tildeBackslash')).toBe(path.join(os.homedir(), 'mcporter-cwd-home'));
    expect(cwdFor('defaulted')).toBe(TEMP_DIR);
  });

  it('normalizes oauthScope from camelCase and snake_case keys', async () => {
    await fs.mkdir(TEMP_DIR, { recursive: true });
    const configPath = path.join(TEMP_DIR, 'mcporter-oauth-scope.json');
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            camel: {
              baseUrl: 'https://example.com/mcp',
              auth: 'oauth',
              oauthScope: 'openid profile',
            },
            snake: {
              baseUrl: 'https://example.com/mcp',
              auth: 'oauth',
              oauth_scope: 'email',
            },
          },
        },
        null,
        2
      ),
      'utf8'
    );

    const servers = await loadServerDefinitions({ configPath });
    const camel = servers.find((entry) => entry.name === 'camel');
    const snake = servers.find((entry) => entry.name === 'snake');
    expect(camel?.oauthScope).toBe('openid profile');
    expect(snake?.oauthScope).toBe('email');
  });

  it('normalizes pre-registered OAuth client fields', async () => {
    await fs.mkdir(TEMP_DIR, { recursive: true });
    const configPath = path.join(TEMP_DIR, 'mcporter-oauth-client.json');
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            camel: {
              baseUrl: 'https://example.com/mcp',
              auth: 'oauth',
              oauthClientId: 'client-123',
              oauthClientSecretEnv: 'OAUTH_SECRET',
              oauthTokenEndpointAuthMethod: 'client_secret_post',
            },
            snake: {
              baseUrl: 'https://example.com/mcp',
              auth: 'oauth',
              oauth_client_id: 'client-456',
              oauth_client_secret: 'secret-inline',
              oauth_token_endpoint_auth_method: 'client_secret_basic',
            },
          },
        },
        null,
        2
      ),
      'utf8'
    );

    const servers = await loadServerDefinitions({ configPath });
    const camel = servers.find((entry) => entry.name === 'camel');
    const snake = servers.find((entry) => entry.name === 'snake');
    expect(camel?.oauthClientId).toBe('client-123');
    expect(camel?.oauthClientSecretEnv).toBe('OAUTH_SECRET');
    expect(camel?.oauthTokenEndpointAuthMethod).toBe('client_secret_post');
    expect(snake?.oauthClientId).toBe('client-456');
    expect(snake?.oauthClientSecret).toBe('secret-inline');
    expect(snake?.oauthTokenEndpointAuthMethod).toBe('client_secret_basic');
  });

  it('resolves env placeholders in string-valued config fields', async () => {
    const originalEnv = { ...process.env };
    process.env.MCPORTER_TEST_HOST = 'api.example.test';
    process.env.MCPORTER_TEST_CLIENT_ID = 'client-from-env';
    process.env.MCPORTER_TEST_SECRET = 'secret-from-env';
    process.env.MCPORTER_TEST_HOME = 'workspace';

    try {
      await fs.mkdir(TEMP_DIR, { recursive: true });
      const configPath = path.join(TEMP_DIR, 'mcporter-env-placeholders.json');
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            mcpServers: {
              http: {
                description: 'Server on ${MCPORTER_TEST_HOST}',
                baseUrl: 'https://${MCPORTER_TEST_HOST}/mcp',
                auth: 'oauth',
                tokenCacheDir: '~/.mcporter/${MCPORTER_TEST_HOST}',
                clientName: 'mcporter-${MCPORTER_TEST_HOST}',
                oauthClientId: '${MCPORTER_TEST_CLIENT_ID}',
                oauthClientSecret: '${MCPORTER_TEST_SECRET}',
                oauthTokenEndpointAuthMethod: '${MCPORTER_TEST_AUTH_METHOD:-client_secret_post}',
                oauthRedirectUrl: 'http://127.0.0.1:3434/${MCPORTER_TEST_HOME}',
                oauthScope: 'openid ${MCPORTER_TEST_SCOPE:-email}',
              },
              stdio: {
                command: 'node',
                args: ['${MCPORTER_TEST_HOME}/server.js', '--tenant=${MCPORTER_TEST_TENANT:-default}'],
                cwd: './${MCPORTER_TEST_HOME}',
                oauthCommand: {
                  args: ['auth', 'http://localhost/${MCPORTER_TEST_HOME}/callback'],
                },
              },
            },
          },
          null,
          2
        ),
        'utf8'
      );

      const servers = await loadServerDefinitions({ configPath });
      const http = servers.find((entry) => entry.name === 'http');
      const stdio = servers.find((entry) => entry.name === 'stdio');

      expect(http?.description).toBe('Server on api.example.test');
      expect(http?.command.kind).toBe('http');
      expect(http?.command.kind === 'http' ? http.command.url.toString() : undefined).toBe(
        'https://api.example.test/mcp'
      );
      expect(http?.tokenCacheDir).toBe(path.join(os.homedir(), '.mcporter', 'api.example.test'));
      expect(http?.clientName).toBe('mcporter-api.example.test');
      expect(http?.oauthClientId).toBe('client-from-env');
      expect(http?.oauthClientSecret).toBe('secret-from-env');
      expect(http?.oauthTokenEndpointAuthMethod).toBe('client_secret_post');
      expect(http?.oauthRedirectUrl).toBe('http://127.0.0.1:3434/workspace');
      expect(http?.oauthScope).toBe('openid email');

      expect(stdio?.command.kind).toBe('stdio');
      expect(stdio?.command.kind === 'stdio' ? stdio.command.args : undefined).toEqual([
        'workspace/server.js',
        '--tenant=default',
      ]);
      expect(stdio?.command.kind === 'stdio' ? stdio.command.cwd : undefined).toBe(path.join(TEMP_DIR, 'workspace'));
      expect(stdio?.oauthCommand?.args).toEqual(['auth', 'http://localhost/workspace/callback']);
    } finally {
      process.env = originalEnv;
    }
  });

  it('keeps secret-bearing env, header, and Env-name fields unresolved until runtime', async () => {
    const originalEnv = { ...process.env };
    process.env.MCPORTER_TEST_HEADER = 'header-secret';
    process.env.MCPORTER_TEST_ENV = 'env-secret';
    process.env.MCPORTER_TEST_BEARER = 'bearer-secret';
    process.env.MCPORTER_TEST_SECRET_ENV_NAME = 'SECRET_ENV_VAR';

    try {
      await fs.mkdir(TEMP_DIR, { recursive: true });
      const configPath = path.join(TEMP_DIR, 'mcporter-deferred-placeholders.json');
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            mcpServers: {
              test: {
                baseUrl: 'https://example.com/mcp',
                headers: {
                  Authorization: 'Bearer ${MCPORTER_TEST_HEADER}',
                  'X-Api-Key': '${MCPORTER_TEST_HEADER}',
                },
                env: {
                  API_KEY: '${MCPORTER_TEST_ENV}',
                },
                bearerToken: '${MCPORTER_TEST_BEARER}',
                oauthClientSecretEnv: '${MCPORTER_TEST_SECRET_ENV_NAME}',
              },
            },
          },
          null,
          2
        ),
        'utf8'
      );

      const servers = await loadServerDefinitions({ configPath });
      const server = servers.find((entry) => entry.name === 'test');

      expect(server?.command.kind).toBe('http');
      expect(server?.command.kind === 'http' ? server.command.headers?.Authorization : undefined).toBe(
        'Bearer ${MCPORTER_TEST_BEARER}'
      );
      expect(server?.command.kind === 'http' ? server.command.headers?.['X-Api-Key'] : undefined).toBe(
        '${MCPORTER_TEST_HEADER}'
      );
      expect(server?.env?.API_KEY).toBe('${MCPORTER_TEST_ENV}');
      expect(server?.oauthClientSecretEnv).toBe('${MCPORTER_TEST_SECRET_ENV_NAME}');
    } finally {
      process.env = originalEnv;
    }
  });

  it('reports the config field when a required placeholder is missing', async () => {
    const originalEnv = { ...process.env };
    delete process.env.MCPORTER_TEST_MISSING_CLIENT_ID;

    try {
      await fs.mkdir(TEMP_DIR, { recursive: true });
      const configPath = path.join(TEMP_DIR, 'mcporter-missing-placeholder.json');
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            mcpServers: {
              test: {
                baseUrl: 'https://example.com/mcp',
                auth: 'oauth',
                oauthClientId: '${MCPORTER_TEST_MISSING_CLIENT_ID}',
              },
            },
          },
          null,
          2
        ),
        'utf8'
      );

      await expect(loadServerDefinitions({ configPath })).rejects.toThrow(
        "Server 'test' field 'oauthClientId' has unresolved env placeholder"
      );
    } finally {
      process.env = originalEnv;
    }
  });
});
