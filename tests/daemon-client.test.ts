import { privateFixtureDirectory } from './helpers/private-directory.js';
import fs from 'node:fs/promises';
import net from 'node:net';
import { expect, it } from 'vitest';
import { DaemonClient, resolveDaemonPaths } from '../src/daemon/client.js';
import { secureDaemonDirectory } from '../src/daemon/paths.js';
import { authenticateServer, daemonKey, SocketFrames } from '../src/daemon/socket-rpc.js';
import type { DaemonRequest } from '../src/daemon/protocol.js';
import { singletonFixture } from './helpers/singleton.js';
it('reports a live compatible host and restores missing metadata through mutual authentication', async () => {
  const f = await singletonFixture();
  try {
    const c = f.client();
    const before = await c.status();
    await fs.unlink(f.paths.metadataPath);
    expect((await c.status())?.generation).toBe(before?.generation);
  } finally {
    await f.close();
  }
});
it('does not disclose resolved context to an impostor socket listener', async () => {
  const root = await privateFixtureDirectory('mcp-impostor-');
  const previous = process.env.MCPORTER_DAEMON_DIR;
  process.env.MCPORTER_DAEMON_DIR = root;
  await secureDaemonDirectory();
  const { socketPath } = resolveDaemonPaths('');
  let captured = '';
  const server = net.createServer((socket) =>
    socket.on('data', (chunk) => {
      captured += chunk.toString();
      socket.end('{"nonce":"invalid","proof":"invalid"}\n');
    })
  );
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    const c = new DaemonClient({ configPath: '' });
    c.setDefinitions([
      {
        name: 'secret-fixture',
        command: { kind: 'http', url: new URL('https://synthetic.invalid') },
        env: { TEST_SECRET: 'synthetic-secret' },
      },
    ]);
    await expect(c.callTool({ server: 'secret-fixture', tool: 'x' })).rejects.toThrow(/authentication/);
    await expect(c.stop()).rejects.toThrow(/authentication/);
    expect(captured).toContain('hello');
    expect(captured).not.toContain('synthetic-secret');
    expect(captured).not.toContain('registerView');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env.MCPORTER_DAEMON_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('accepts an orderly disconnect after an authenticated stop request', async () => {
  const root = await privateFixtureDirectory('mcp-stop-eof-');
  const previous = process.env.MCPORTER_DAEMON_DIR;
  process.env.MCPORTER_DAEMON_DIR = root;
  const key = await daemonKey();
  const { socketPath } = resolveDaemonPaths('');
  const handled = Promise.withResolvers<DaemonRequest>();
  void handled.promise.catch(() => {});
  const server = net.createServer((socket) => {
    const frames = new SocketFrames(socket);
    void (async () => {
      await authenticateServer(frames, key);
      const request = (await frames.read()) as DaemonRequest;
      handled.resolve(request);
      socket.end();
    })().catch((error: Error) => {
      handled.reject(error);
      socket.destroy(error);
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    await expect(new DaemonClient({ configPath: '' }).stop()).resolves.toBeUndefined();
    expect(await handled.promise).toMatchObject({ method: 'stop' });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    key.fill(0);
    if (previous === undefined) delete process.env.MCPORTER_DAEMON_DIR;
    else process.env.MCPORTER_DAEMON_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('rejects EOF before authentication even for daemon stop', async () => {
  const root = await privateFixtureDirectory('mcp-stop-auth-eof-');
  const previous = process.env.MCPORTER_DAEMON_DIR;
  process.env.MCPORTER_DAEMON_DIR = root;
  await secureDaemonDirectory();
  const { socketPath } = resolveDaemonPaths('');
  const server = net.createServer((socket) => socket.once('data', () => socket.end()));
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    await expect(new DaemonClient({ configPath: '' }).stop()).rejects.toThrow(/authentication/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previous === undefined) delete process.env.MCPORTER_DAEMON_DIR;
    else process.env.MCPORTER_DAEMON_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
