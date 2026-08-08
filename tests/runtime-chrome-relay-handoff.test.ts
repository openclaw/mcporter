import { Client, SdkError, SdkErrorCode, type Transport } from '@modelcontextprotocol/client';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHROME_RELAY_HANDOFF_ENV } from '../src/chrome-devtools-relay-handoff.js';
import type { ServerDefinition } from '../src/config.js';
import { createClientContext } from '../src/runtime/transport.js';
import { clientInfo, createLogger, resetLogger } from './helpers/runtime-test-helpers.js';

const STABLE_RELAY_TOKEN = 'a'.repeat(64);
const logger = createLogger();

beforeEach(() => resetLogger(logger));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('runtime Chrome relay handoff lifecycle', () => {
  it('keeps both credentials out of spawn args and cleans the first handoff before negotiation retry', async () => {
    const fixture = await createRelayFixture();
    const attempts: SpawnShape[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 }))
    );
    vi.spyOn(Client.prototype, 'connect')
      .mockImplementationOnce(async (transport) => {
        attempts.push(await inspectSpawnShape(transport));
        throw new SdkError(SdkErrorCode.EraNegotiationFailed, 'fixture requests legacy retry');
      })
      .mockImplementationOnce(async (transport) => {
        attempts.push(await inspectSpawnShape(transport));
      });

    try {
      const context = await createClientContext(fixture.definition, logger, clientInfo);
      expect(attempts).toHaveLength(2);
      assertCredentialFreeSpawn(attempts[0]!);
      assertCredentialFreeSpawn(attempts[1]!);
      await expect(fs.stat(attempts[0]!.handoffPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(connect(attempts[0]!.port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
      await expect(fs.stat(attempts[1]!.handoffPath)).resolves.toBeDefined();

      await context.transport.close();
      await expect(fs.stat(attempts[1]!.handoffPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(connect(attempts[1]!.port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    } finally {
      await fs.rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('cleans the proxy and protected handoff when connection setup is aborted', async () => {
    const fixture = await createRelayFixture();
    const controller = new AbortController();
    controller.abort();
    let attempt: SpawnShape | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 }))
    );
    vi.spyOn(Client.prototype, 'connect').mockImplementationOnce(async (transport) => {
      attempt = await inspectSpawnShape(transport);
      throw new DOMException('aborted', 'AbortError');
    });

    try {
      await expect(
        createClientContext(fixture.definition, logger, clientInfo, { signal: controller.signal })
      ).rejects.toThrow('aborted');
      expect(attempt).toBeDefined();
      await expect(fs.stat(attempt!.handoffPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(connect(attempt!.port)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    } finally {
      await fs.rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('cleans relay resources when transport wrapping fails before child start', async () => {
    const fixture = await createRelayFixture();
    let handoffPath: string | undefined;
    let port: number | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 }))
    );

    try {
      await expect(
        createClientContext(fixture.definition, logger, clientInfo, {
          onTransportCreated: (transport) => {
            const params = (
              transport as unknown as {
                _serverParams: { args?: readonly string[]; env?: Record<string, string> };
              }
            )._serverParams;
            handoffPath = params.env?.[CHROME_RELAY_HANDOFF_ENV];
            const endpoint = params.args?.at(-1);
            port = endpoint ? Number(new URL(endpoint).port) : undefined;
            throw new Error('fixture wrapping failure');
          },
        })
      ).rejects.toThrow('fixture wrapping failure');
      expect(handoffPath).toBeDefined();
      expect(port).toBeTypeOf('number');
      await expect(fs.stat(handoffPath!)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(connect(port!)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    } finally {
      await fs.rm(fixture.directory, { recursive: true, force: true });
    }
  });

  it('falls back to legacy for prefer but fails closed for require when protected handoff setup fails', async () => {
    const fixture = await createRelayFixture();
    const blocker = path.join(fixture.directory, 'not-a-directory');
    await fs.writeFile(blocker, 'block');
    vi.spyOn(os, 'tmpdir').mockReturnValue(blocker);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 }))
    );
    let preferredArgs: readonly string[] = [];
    const connectSpy = vi.spyOn(Client.prototype, 'connect').mockImplementationOnce(async (transport) => {
      preferredArgs =
        (
          transport as unknown as {
            _serverParams: { args?: readonly string[]; env?: Record<string, string> };
          }
        )._serverParams.args ?? [];
    });

    try {
      const preferred = await createClientContext(fixture.definition, logger, clientInfo);
      expect(preferredArgs).toContain('--autoConnect');
      expect(preferredArgs).not.toContain('--wsEndpoint');
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('"route":"legacy"'));
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('"reason":"handoff-error"'));
      await preferred.transport.close();

      const requiredDefinition: ServerDefinition = { ...fixture.definition, chromeDevtoolsRelay: 'require' };
      await expect(createClientContext(requiredDefinition, logger, clientInfo)).rejects.toMatchObject({
        name: 'ChromeDevtoolsRelayRequiredError',
        decision: expect.objectContaining({ route: 'unavailable', reason: 'handoff-error', policy: 'require' }),
      });
      expect(connectSpy).toHaveBeenCalledOnce();
    } finally {
      await fs.rm(fixture.directory, { recursive: true, force: true });
    }
  });
});

interface SpawnShape {
  readonly args: readonly string[];
  readonly env: Record<string, string>;
  readonly ephemeralAuthorization: string;
  readonly handoffPath: string;
  readonly port: number;
}

async function createRelayFixture(): Promise<{ directory: string; definition: ServerDefinition }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-runtime-relay-'));
  await fs.writeFile(path.join(directory, 'browser-extension-relay.secret'), STABLE_RELAY_TOKEN, { mode: 0o600 });
  return {
    directory,
    definition: {
      name: 'chrome-devtools',
      command: {
        kind: 'stdio',
        command: 'npx',
        args: ['-y', 'chrome-devtools-mcp@latest', '--autoConnect'],
        cwd: directory,
      },
      env: { OPENCLAW_OAUTH_DIR: directory, NODE_OPTIONS: '--trace-warnings' },
    },
  };
}

async function inspectSpawnShape(transport: Transport): Promise<SpawnShape> {
  const params = (
    transport as unknown as {
      _serverParams: { args?: readonly string[]; env?: Record<string, string> };
    }
  )._serverParams;
  const args = params.args ?? [];
  const env = params.env ?? {};
  const handoffPath = env[CHROME_RELAY_HANDOFF_ENV];
  if (!handoffPath) throw new Error('missing test handoff path');
  const payload = JSON.parse(await fs.readFile(handoffPath, 'utf8')) as { Authorization?: string };
  if (!payload.Authorization) throw new Error('missing test authorization');
  const endpoint = args.at(-1);
  if (!endpoint) throw new Error('missing test endpoint');
  return {
    args,
    env,
    ephemeralAuthorization: payload.Authorization,
    handoffPath,
    port: Number(new URL(endpoint).port),
  };
}

function assertCredentialFreeSpawn(shape: SpawnShape): void {
  const renderedArgs = shape.args.join('\0');
  expect(renderedArgs).not.toContain(STABLE_RELAY_TOKEN);
  expect(renderedArgs).not.toContain(shape.ephemeralAuthorization);
  expect(shape.args).not.toContain('--wsHeaders');
  expect(shape.args.at(-1)).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/cdp$/u);
  expect(shape.env[CHROME_RELAY_HANDOFF_ENV]).toBe(shape.handoffPath);
  expect(shape.env.NODE_OPTIONS).toContain('--trace-warnings');
  expect(shape.env.NODE_OPTIONS).toContain('--import=file://');
  expect(shape.env[CHROME_RELAY_HANDOFF_ENV]).not.toContain(shape.ephemeralAuthorization);
}

async function connect(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('error', reject);
  });
}
