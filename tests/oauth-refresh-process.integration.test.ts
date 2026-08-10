import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureDistBuilt } from './helpers/dist.js';
import { budget } from './helpers/timing.js';

const CLI_ENTRY = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const PROCESS_FIXTURE = fileURLToPath(new URL('./fixtures/oauth-refresh-process.mjs', import.meta.url));

describe('OAuth refresh across fresh built-artifact processes', () => {
  let server: Server;
  let endpoint: string;
  let authOrigin: string;
  let tempDir: string;
  const tokenRequests: URLSearchParams[] = [];

  beforeAll(async () => {
    await ensureDistBuilt(CLI_ENTRY);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-refresh-process-'));
    server = createServer(async (request, response) => {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const url = new URL(request.url ?? '/', base);
      if (url.pathname.includes('.well-known/oauth-protected-resource')) {
        return sendJson(response, {
          resource: endpoint,
          authorization_servers: [authOrigin],
        });
      }
      if (
        url.pathname.includes('.well-known/oauth-authorization-server') ||
        url.pathname.includes('openid-configuration')
      ) {
        return sendJson(response, {
          issuer: authOrigin,
          authorization_endpoint: `${authOrigin}/authorize`,
          token_endpoint: `${authOrigin}/token`,
          registration_endpoint: `${authOrigin}/register`,
          response_types_supported: ['code'],
          grant_types_supported: ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported: ['none'],
          code_challenge_methods_supported: ['S256'],
        });
      }
      if (url.pathname === '/token' && request.method === 'POST') {
        const body = await readBody(request);
        tokenRequests.push(new URLSearchParams(body));
        return sendJson(response, {
          access_token: 'fresh-process-access-token',
          token_type: 'Bearer',
          refresh_token: 'rotated-process-refresh-token',
          expires_in: 3600,
        });
      }
      response.statusCode = 404;
      response.end('not found');
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    authOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    endpoint = `${authOrigin}/mcp`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it(
    'keeps the dynamic client identity after a silent refresh in a new process',
    async () => {
      const env = {
        ...process.env,
        HOME: path.join(tempDir, 'home'),
        XDG_CONFIG_HOME: path.join(tempDir, 'config'),
        XDG_DATA_HOME: path.join(tempDir, 'data'),
        XDG_CACHE_HOME: path.join(tempDir, 'cache'),
        XDG_STATE_HOME: path.join(tempDir, 'state'),
        MCPORTER_TEST_OAUTH_ENDPOINT: endpoint,
        MCPORTER_TEST_OAUTH_CACHE_DIR: path.join(tempDir, 'oauth-cache'),
      };

      await runFixture('seed', env);
      const result = JSON.parse(await runFixture('refresh', env)) as {
        accessToken: string;
        authorizationPrompts: number;
        clientId: string;
        refreshToken: string;
      };

      expect(result).toEqual({
        accessToken: 'fresh-process-access-token',
        authorizationPrompts: 0,
        clientId: 'fresh-process-client',
        refreshToken: 'rotated-process-refresh-token',
      });
      expect(tokenRequests).toHaveLength(1);
      expect(tokenRequests[0]?.get('grant_type')).toBe('refresh_token');
      expect(tokenRequests[0]?.get('refresh_token')).toBe('fresh-process-refresh-token');
      expect(tokenRequests[0]?.get('client_id')).toBe('fresh-process-client');
    },
    budget(20_000)
  );
});

function runFixture(action: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [PROCESS_FIXTURE, action],
      { env, timeout: budget(15_000), maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${error.message}\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`));
          return;
        }
        resolve(stdout.trim());
      }
    );
  });
}

function sendJson(response: import('node:http').ServerResponse, body: unknown): void {
  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}

async function readBody(request: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
