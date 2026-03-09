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
});
