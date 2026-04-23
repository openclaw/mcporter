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

  it('respects cwd on stdio servers (absolute, relative, ~, and default)', async () => {
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
            tildeOnly: {
              command: 'node',
              args: ['server.js'],
              cwd: '~',
            },
            empty: {
              command: 'node',
              args: ['server.js'],
              cwd: '',
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
    const absolute = servers.find((entry) => entry.name === 'absolute');
    const relative = servers.find((entry) => entry.name === 'relative');
    const tilde = servers.find((entry) => entry.name === 'tilde');
    const tildeOnly = servers.find((entry) => entry.name === 'tildeOnly');
    const empty = servers.find((entry) => entry.name === 'empty');
    const defaulted = servers.find((entry) => entry.name === 'defaulted');

    expect(absolute?.command.kind).toBe('stdio');
    expect(absolute?.command.kind === 'stdio' ? absolute.command.cwd : undefined).toBe(absoluteCwd);

    expect(relative?.command.kind === 'stdio' ? relative.command.cwd : undefined).toBe(
      path.resolve(TEMP_DIR, 'packages/foo')
    );

    expect(tilde?.command.kind === 'stdio' ? tilde.command.cwd : undefined).toBe(
      path.join(os.homedir(), 'mcporter-cwd-home')
    );

    expect(tildeOnly?.command.kind === 'stdio' ? tildeOnly.command.cwd : undefined).toBe(os.homedir());

    expect(empty?.command.kind === 'stdio' ? empty.command.cwd : undefined).toBe(TEMP_DIR);

    expect(defaulted?.command.kind === 'stdio' ? defaulted.command.cwd : undefined).toBe(TEMP_DIR);
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
