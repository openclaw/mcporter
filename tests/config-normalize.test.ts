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

  it('resolves environment placeholders across string-valued config fields', async () => {
    const previousClientId = process.env.MCPORTER_TEST_CLIENT_ID;
    const previousSecret = process.env.MCPORTER_TEST_SECRET;
    const previousCwd = process.env.MCPORTER_TEST_CWD;
    try {
      process.env.MCPORTER_TEST_CLIENT_ID = 'client-from-env';
      delete process.env.MCPORTER_TEST_SECRET;
      process.env.MCPORTER_TEST_CWD = 'workspace';

      await fs.mkdir(TEMP_DIR, { recursive: true });
      const configPath = path.join(TEMP_DIR, 'mcporter-env-placeholders.json');
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            mcpServers: {
              http: {
                baseUrl: 'https://${MCPORTER_TEST_HOST:-example.com}/mcp',
                auth: 'oauth',
                oauthClientId: '${MCPORTER_TEST_CLIENT_ID}',
                oauthClientSecret: '${MCPORTER_TEST_SECRET:-fallback-secret}',
                oauthCommand: {
                  args: ['login', '${MCPORTER_TEST_CLIENT_ID}'],
                },
              },
              stdio: {
                command: 'node',
                args: ['server.js', '--client=${MCPORTER_TEST_CLIENT_ID}'],
                cwd: '${MCPORTER_TEST_CWD}',
                env: {
                  CLIENT_ID: '${MCPORTER_TEST_CLIENT_ID}',
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

      expect(http?.command.kind).toBe('http');
      expect(http?.command.kind === 'http' ? http.command.url.href : undefined).toBe('https://example.com/mcp');
      expect(http?.oauthClientId).toBe('client-from-env');
      expect(http?.oauthClientSecret).toBe('fallback-secret');
      expect(http?.oauthCommand?.args).toEqual(['login', 'client-from-env']);

      expect(stdio?.command.kind).toBe('stdio');
      expect(stdio?.command.kind === 'stdio' ? stdio.command.args : undefined).toEqual([
        'server.js',
        '--client=client-from-env',
      ]);
      expect(stdio?.command.kind === 'stdio' ? stdio.command.cwd : undefined).toBe(path.resolve(TEMP_DIR, 'workspace'));
      expect(stdio?.env).toEqual({ CLIENT_ID: 'client-from-env' });
    } finally {
      if (previousClientId === undefined) {
        delete process.env.MCPORTER_TEST_CLIENT_ID;
      } else {
        process.env.MCPORTER_TEST_CLIENT_ID = previousClientId;
      }
      if (previousSecret === undefined) {
        delete process.env.MCPORTER_TEST_SECRET;
      } else {
        process.env.MCPORTER_TEST_SECRET = previousSecret;
      }
      if (previousCwd === undefined) {
        delete process.env.MCPORTER_TEST_CWD;
      } else {
        process.env.MCPORTER_TEST_CWD = previousCwd;
      }
    }
  });

  it('reports the config field when a required placeholder is missing', async () => {
    const previousClientId = process.env.MCPORTER_TEST_MISSING_CLIENT_ID;
    try {
      delete process.env.MCPORTER_TEST_MISSING_CLIENT_ID;

      await fs.mkdir(TEMP_DIR, { recursive: true });
      const configPath = path.join(TEMP_DIR, 'mcporter-env-missing.json');
      await fs.writeFile(
        configPath,
        JSON.stringify(
          {
            mcpServers: {
              oauth: {
                baseUrl: 'https://example.com/mcp',
                oauthClientId: '${MCPORTER_TEST_MISSING_CLIENT_ID}',
              },
            },
          },
          null,
          2
        ),
        'utf8'
      );

      await expect(loadServerDefinitions({ configPath })).rejects.toThrow(/oauthClientId/);
    } finally {
      if (previousClientId === undefined) {
        delete process.env.MCPORTER_TEST_MISSING_CLIENT_ID;
      } else {
        process.env.MCPORTER_TEST_MISSING_CLIENT_ID = previousClientId;
      }
    }
  });
});
