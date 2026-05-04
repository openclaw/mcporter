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
});
