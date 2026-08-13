import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
// The child processes exercise the built artifact; this parent only needs the
// same lock-path derivation, so it imports source rather than requiring dist to
// exist at typecheck time.
import { withFileLock } from '../src/fs-json.js';
import { refreshLockPaths } from '../src/oauth-refresh-lock.js';
import { ensureDistBuilt } from './helpers/dist.js';
import { budget } from './helpers/timing.js';

const CLI_ENTRY = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const PROCESS_FIXTURE = fileURLToPath(new URL('./fixtures/oauth-refresh-process.mjs', import.meta.url));

/**
 * A refresh token generation belonging to a rotation family. Redeeming a spent
 * generation is a replay, which providers such as Notion treat as a stolen-token
 * signal and answer by revoking the whole family (RFC 9700 4.14.2).
 */
interface Generation {
  family: string;
  spent: boolean;
}

function marker(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

describe('OAuth refresh across fresh built-artifact processes', () => {
  let server: Server;
  let endpoint: string;
  let authOrigin: string;
  let tempDir: string;

  let tokenRequests: URLSearchParams[] = [];
  let generations: Map<string, Generation>;
  let revokedFamilies: Set<string>;
  let replays: URLSearchParams[] = [];
  let issuedByFamily: Map<string, number>;
  let transientFailuresRemaining = 0;
  let post401InitialRequests = 0;
  let post401RetryRequests = 0;
  let releasePost401Requests: (() => void) | undefined;
  let post401RequestsArrived: Promise<void> | undefined;
  // Set to hold the first token request open until a second family arrives, so
  // "unrelated identities refresh concurrently" is proven by overlap.
  let overlapBarrier: { arrived: Map<string, () => void>; release: Promise<void> } | undefined;

  function registerSeed(refreshToken: string, family: string): void {
    generations.set(refreshToken, { family, spent: false });
  }

  beforeAll(async () => {
    await ensureDistBuilt(CLI_ENTRY);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-refresh-process-'));
    server = createServer(async (request, response) => {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const url = new URL(request.url ?? '/', base);
      if (url.pathname.includes('.well-known/oauth-protected-resource')) {
        return sendJson(response, { resource: endpoint, authorization_servers: [authOrigin] });
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
        const params = new URLSearchParams(await readBody(request));
        tokenRequests.push(params);
        if (transientFailuresRemaining > 0) {
          transientFailuresRemaining -= 1;
          return sendError(response, 'temporarily_unavailable', 503);
        }
        const presented = params.get('refresh_token') ?? '';
        const generation = generations.get(presented);

        if (!generation || revokedFamilies.has(generation.family)) {
          return sendError(response, 'invalid_grant');
        }
        if (generation.spent) {
          replays.push(params);
          revokedFamilies.add(generation.family);
          return sendError(response, 'invalid_grant');
        }

        if (overlapBarrier) {
          overlapBarrier.arrived.get(generation.family)?.();
          await overlapBarrier.release;
        }

        generation.spent = true;
        // Per family, so one identity's rotations do not renumber another's.
        const issued = (issuedByFamily.get(generation.family) ?? 0) + 1;
        issuedByFamily.set(generation.family, issued);
        const rotated = `rotated-${generation.family}-${issued}`;
        generations.set(rotated, { family: generation.family, spent: false });
        return sendJson(response, {
          access_token: `access-${generation.family}-${issued}`,
          token_type: 'Bearer',
          refresh_token: rotated,
          expires_in: 3600,
        });
      }
      if (url.pathname === '/mcp') {
        const authorization = request.headers.authorization;
        if (authorization === 'Bearer post-401-access') {
          post401InitialRequests += 1;
          if (post401InitialRequests === 2) releasePost401Requests?.();
          await post401RequestsArrived;
          response.statusCode = 401;
          response.setHeader(
            'WWW-Authenticate',
            `Bearer resource_metadata="${authOrigin}/.well-known/oauth-protected-resource"`
          );
          response.end('unauthorized');
          return;
        }
        if (authorization === 'Bearer access-post-401-1') {
          post401RetryRequests += 1;
          response.statusCode = 202;
          response.end();
          return;
        }
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

  beforeEach(() => {
    tokenRequests = [];
    replays = [];
    generations = new Map();
    revokedFamilies = new Set();
    issuedByFamily = new Map();
    transientFailuresRemaining = 0;
    post401InitialRequests = 0;
    post401RetryRequests = 0;
    releasePost401Requests = undefined;
    post401RequestsArrived = undefined;
    overlapBarrier = undefined;
  });

  afterEach(() => {
    overlapBarrier = undefined;
  });

  async function freshEnv(name: string, seedRefresh: string): Promise<NodeJS.ProcessEnv> {
    const root = await fs.mkdtemp(path.join(tempDir, `${name}-`));
    return {
      ...process.env,
      HOME: path.join(root, 'home'),
      XDG_CONFIG_HOME: path.join(root, 'config'),
      XDG_DATA_HOME: path.join(root, 'data'),
      XDG_CACHE_HOME: path.join(root, 'cache'),
      XDG_STATE_HOME: path.join(root, 'state'),
      MCPORTER_TEST_OAUTH_ENDPOINT: endpoint,
      MCPORTER_TEST_OAUTH_CACHE_DIR: path.join(root, 'oauth-cache'),
      MCPORTER_TEST_OAUTH_SERVER_NAME: name,
      MCPORTER_TEST_OAUTH_SEED_REFRESH: seedRefresh,
    };
  }

  it(
    'keeps the dynamic client identity after a silent refresh in a new process',
    async () => {
      const seed = 'legacy-seed-refresh';
      registerSeed(seed, 'legacy');
      const env = await freshEnv('oauth-refresh-process', seed);

      await runFixture('seed', env);
      const result = JSON.parse(await runFixture('refresh', env)) as {
        accessToken: string;
        authorizationPrompts: number;
        clientId: string;
        refreshToken: string;
      };

      expect(result.authorizationPrompts).toBe(0);
      expect(result.clientId).toBe('fresh-process-client');
      expect(result.accessToken).toBe('access-legacy-1');
      expect(result.refreshToken).toBe('rotated-legacy-1');
      expect(tokenRequests).toHaveLength(1);
      expect(tokenRequests[0]?.get('grant_type')).toBe('refresh_token');
      expect(tokenRequests[0]?.get('refresh_token')).toBe(seed);
      expect(tokenRequests[0]?.get('client_id')).toBe('fresh-process-client');
    },
    budget(20_000)
  );

  for (const variant of [
    { action: 'refresh-cached', label: 'cached-read path' },
    { action: 'refresh-connect', label: 'provider path' },
  ] as const) {
    it(
      `redeems a rotating refresh token exactly once across concurrent processes (${variant.label})`,
      async () => {
        const seed = `wave-seed-${variant.action}`;
        registerSeed(seed, 'wave');
        const env = await freshEnv(`wave-${variant.action}`, seed);
        await runFixture('seed', env);

        // Twelve callers, matching the reproduction in issue #305.
        const outputs = await Promise.all(
          Array.from({ length: 12 }, () => runFixture(variant.action, env).then((raw) => JSON.parse(raw)))
        );

        const seededRedemptions = tokenRequests.filter((request) => request.get('refresh_token') === seed);
        expect(seededRedemptions).toHaveLength(1);
        expect(replays).toHaveLength(0);
        expect(revokedFamilies.has('wave')).toBe(false);

        // Every caller converges on the one generation the winner persisted.
        const winnerMarker = marker('access-wave-1');
        const persisted = new Set(outputs.map((output) => output.persistedAccessMarker));
        expect([...persisted]).toEqual([winnerMarker]);
        for (const output of outputs) {
          expect(output.persistedRefreshMarker).toBe(marker('rotated-wave-1'));
          if (variant.action === 'refresh-cached') {
            expect(output.accessMarker).toBe(winnerMarker);
          } else {
            expect(output.authorizationPrompts).toBe(0);
          }
          expect(JSON.stringify(output)).not.toContain('access-wave-1');
          expect(JSON.stringify(output)).not.toContain('rotated-wave-1');
        }

        // The rotated generation still refreshes normally afterwards.
        await fs.writeFile(
          path.join(env.MCPORTER_TEST_OAUTH_CACHE_DIR ?? '', 'tokens.json'),
          JSON.stringify({
            access_token: 'access-wave-1',
            token_type: 'Bearer',
            refresh_token: 'rotated-wave-1',
            expires_at: 1,
          })
        );
        const later = JSON.parse(await runFixture('refresh-cached', env)) as { accessMarker: string };
        expect(later.accessMarker).toBe(marker('access-wave-2'));
        expect(replays).toHaveLength(0);
        expect(revokedFamilies.has('wave')).toBe(false);
      },
      budget(60_000)
    );
  }

  it(
    'redeems exactly once when two processes receive 401 for the same fresh token',
    async () => {
      const seed = 'post-401-seed';
      registerSeed(seed, 'post-401');
      const env = await freshEnv('post-401-refresh', seed);
      await runFixture('seed-post-401', env);

      post401RequestsArrived = new Promise<void>((resolve) => {
        releasePost401Requests = resolve;
      });
      const outputs = await Promise.all(
        Array.from({ length: 2 }, () => runFixture('post-401-refresh', env).then((raw) => JSON.parse(raw)))
      );

      expect(post401InitialRequests).toBe(2);
      expect(post401RetryRequests).toBe(2);
      expect(tokenRequests.filter((request) => request.get('refresh_token') === seed)).toHaveLength(1);
      expect(replays).toHaveLength(0);
      expect(revokedFamilies.has('post-401')).toBe(false);
      for (const output of outputs) {
        expect(output.persistedAccessMarker).toBe(marker('access-post-401-1'));
        expect(output.persistedRefreshMarker).toBe(marker('rotated-post-401-1'));
        expect(JSON.stringify(output)).not.toContain('access-post-401-1');
        expect(JSON.stringify(output)).not.toContain('rotated-post-401-1');
      }
    },
    budget(30_000)
  );

  it(
    'lets unrelated credential identities refresh at the same time',
    async () => {
      registerSeed('alpha-seed', 'alpha');
      registerSeed('beta-seed', 'beta');
      const alphaEnv = await freshEnv('identity-alpha', 'alpha-seed');
      const betaEnv = await freshEnv('identity-beta', 'beta-seed');
      await Promise.all([runFixture('seed', alphaEnv), runFixture('seed', betaEnv)]);

      // Both requests must be in flight before either completes; a lock that
      // serialized unrelated identities would deadlock this barrier.
      let releaseBoth!: () => void;
      const release = new Promise<void>((resolve) => {
        releaseBoth = resolve;
      });
      const arrivals = new Map<string, () => void>();
      const alphaArrived = new Promise<void>((resolve) => arrivals.set('alpha', resolve));
      const betaArrived = new Promise<void>((resolve) => arrivals.set('beta', resolve));
      overlapBarrier = { arrived: arrivals, release };

      const runs = Promise.all([runFixture('refresh-cached', alphaEnv), runFixture('refresh-cached', betaEnv)]);
      await Promise.all([alphaArrived, betaArrived]);
      releaseBoth();

      const [alpha, beta] = (await runs).map((raw) => JSON.parse(raw) as { accessMarker: string });
      expect(alpha?.accessMarker).toBe(marker('access-alpha-1'));
      expect(beta?.accessMarker).toBe(marker('access-beta-1'));
      expect(replays).toHaveLength(0);
    },
    budget(30_000)
  );

  async function holdRefreshLock(
    name: string,
    env: NodeJS.ProcessEnv
  ): Promise<{ release: () => void; settled: Promise<void> }> {
    const previousDataHome = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = env.XDG_DATA_HOME;
    const lockPaths = await refreshLockPaths({
      name,
      command: { kind: 'http', url: new URL(endpoint) },
      auth: 'oauth',
      tokenCacheDir: env.MCPORTER_TEST_OAUTH_CACHE_DIR,
    });
    process.env.XDG_DATA_HOME = previousDataHome;

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const settled = withFileLock(lockPaths[0] ?? '', async () => {
      await held;
    });
    return { release, settled };
  }

  it(
    'returns the persisted token without redeeming when another process holds the lock',
    async () => {
      const seed = 'held-seed';
      registerSeed(seed, 'held');
      const env = await freshEnv('lock-held', seed);
      await runFixture('seed', env);
      const holder = await holdRefreshLock('lock-held', env);

      const waiter = JSON.parse(
        await runFixture('refresh-cached', { ...env, MCPORTER_TEST_REFRESH_LOCK_TIMEOUT_MS: '400' })
      ) as { accessMarker: string };
      holder.release();
      await holder.settled;

      // The waiter keeps the seeded (expired) token rather than redeeming it
      // outside the lock, which is what would replay against the provider.
      expect(waiter.accessMarker).toBe(marker('expired-process-token'));
      expect(tokenRequests).toHaveLength(0);
      expect(replays).toHaveLength(0);
    },
    budget(30_000)
  );

  it(
    'refuses to let the provider path redeem after the lock times out',
    async () => {
      const seed = 'held-connect-seed';
      registerSeed(seed, 'held-connect');
      const env = await freshEnv('lock-held-connect', seed);
      await runFixture('seed', env);
      const holder = await holdRefreshLock('lock-held-connect', env);

      const result = JSON.parse(
        await runFixture('refresh-connect', { ...env, MCPORTER_TEST_REFRESH_LOCK_TIMEOUT_MS: '400' })
      ) as { refreshUnavailable: boolean; authorizationPrompts: number };
      holder.release();
      await holder.settled;

      // Handing the SDK the expired-but-refreshable token would let it redeem
      // the spent generation outside the lock and revoke the family.
      expect(result.refreshUnavailable).toBe(true);
      expect(tokenRequests).toHaveLength(0);
      expect(replays).toHaveLength(0);
      // Failing beats prompting: the credentials are valid and being refreshed.
      expect(result.authorizationPrompts).toBe(0);
    },
    budget(30_000)
  );

  it(
    'breaks a lock left behind by a dead process',
    async () => {
      const seed = 'stale-seed';
      registerSeed(seed, 'stale');
      const env = await freshEnv('stale-lock', seed);
      await runFixture('seed', env);

      const previousDataHome = process.env.XDG_DATA_HOME;
      process.env.XDG_DATA_HOME = env.XDG_DATA_HOME;
      const lockPaths = await refreshLockPaths({
        name: 'stale-lock',
        command: { kind: 'http', url: new URL(endpoint) },
        auth: 'oauth',
        tokenCacheDir: env.MCPORTER_TEST_OAUTH_CACHE_DIR,
      });
      process.env.XDG_DATA_HOME = previousDataHome;

      const lockFile = `${lockPaths[0]}.lock`;
      await fs.mkdir(path.dirname(lockFile), { recursive: true });
      // A pid that is not running: the holder died mid-transaction.
      await fs.writeFile(lockFile, `2147483646\n${new Date().toISOString()}\n`);

      const result = JSON.parse(await runFixture('refresh-cached', env)) as { accessMarker: string };
      expect(result.accessMarker).toBe(marker('access-stale-1'));
      expect(replays).toHaveLength(0);
    },
    budget(30_000)
  );

  it.runIf(process.platform !== 'win32')(
    'recovers after an actual lock holder process is killed',
    async () => {
      const seed = 'killed-holder-seed';
      registerSeed(seed, 'killed-holder');
      const env = await freshEnv('killed-holder', seed);
      await runFixture('seed', env);

      const holder = await startLockHolder(env);
      holder.kill('SIGKILL');
      await new Promise<void>((resolve) => holder.once('exit', () => resolve()));

      const result = JSON.parse(await runFixture('refresh-cached', env)) as { accessMarker: string };
      expect(result.accessMarker).toBe(marker('access-killed-holder-1'));
      expect(tokenRequests).toHaveLength(1);
      expect(replays).toHaveLength(0);
      expect(revokedFamilies.has('killed-holder')).toBe(false);
    },
    budget(30_000)
  );

  it(
    'lets another process refresh after a transient holder failure',
    async () => {
      const seed = 'transient-seed';
      registerSeed(seed, 'transient');
      const env = await freshEnv('transient-failure', seed);
      await runFixture('seed', env);
      transientFailuresRemaining = 1;

      const failed = JSON.parse(await runFixture('refresh-cached', env)) as { accessMarker: string };
      expect(failed.accessMarker).toBe(marker('expired-process-token'));

      const recovered = JSON.parse(await runFixture('refresh-cached', env)) as { accessMarker: string };
      expect(recovered.accessMarker).toBe(marker('access-transient-1'));
      expect(tokenRequests).toHaveLength(2);
      expect(replays).toHaveLength(0);
      expect(revokedFamilies.has('transient')).toBe(false);
    },
    budget(30_000)
  );

  it(
    'degrades to a clean re-auth when a process dies between redeeming and persisting',
    async () => {
      const seed = 'crash-seed';
      registerSeed(seed, 'crash');
      const env = await freshEnv('crash-after-redeem', seed);
      await runFixture('seed', env);

      // The provider rotated; this process never persisted the result.
      const crashed = JSON.parse(await runFixture('redeem-without-persisting', env)) as { redeemed: boolean };
      expect(crashed.redeemed).toBe(true);

      // The next caller can only present the spent generation. The replay is
      // unavoidable here, so the requirement is that recovery leaves a clean
      // state rather than a corrupt vault or a retry loop.
      const after = JSON.parse(await runFixture('refresh-cached', env)) as {
        accessMarker: string | null;
        persistedAccessMarker: string | null;
      };

      expect(replays).toHaveLength(1);
      expect(revokedFamilies.has('crash')).toBe(true);
      expect(after.accessMarker).toBeNull();
      expect(after.persistedAccessMarker).toBeNull();
    },
    budget(30_000)
  );
});

function runFixture(action: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [PROCESS_FIXTURE, action],
      { env, timeout: budget(20_000), maxBuffer: 1024 * 1024 },
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

function startLockHolder(env: NodeJS.ProcessEnv): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PROCESS_FIXTURE, 'hold-refresh-lock'], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      reject(new Error(`Lock holder exited before acquiring the lock (code=${code}, signal=${signal}): ${stderr}`));
    });
    child.stdout?.once('data', (chunk) => {
      const message = JSON.parse(String(chunk)) as { holding?: boolean };
      if (!message.holding) {
        reject(new Error(`Unexpected lock-holder output: ${String(chunk)}`));
        return;
      }
      resolve(child);
    });
  });
}

function sendJson(response: import('node:http').ServerResponse, body: unknown): void {
  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}

function sendError(response: import('node:http').ServerResponse, error: string, status = 400): void {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify({ error }));
}

async function readBody(request: import('node:http').IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
