import fs from 'node:fs/promises';
import net from 'node:net';
import { expect, it, vi } from 'vitest';
import * as paths from '../src/daemon/paths.js';
import { authenticateServer, daemonKey, requestDaemon, SocketFrames } from '../src/daemon/socket-rpc.js';
import { DAEMON_PROTOCOL_VERSION } from '../src/daemon/protocol.js';
import { privateFixtureDirectory } from './helpers/private-directory.js';

it('starts the network health deadline after local directory security verification', async () => {
  const root = await privateFixtureDirectory('mcp-health-');
  vi.stubEnv('MCPORTER_DAEMON_DIR', root);
  const key = await daemonKey();
  const server = net.createServer((socket) => {
    const frames = new SocketFrames(socket);
    void (async () => {
      await authenticateServer(frames, key);
      const request = (await frames.read()) as { id: string };
      frames.write({ id: request.id, ok: true, result: 'healthy' });
      socket.end();
    })().catch(() => socket.destroy());
  });
  await new Promise<void>((resolve) => server.listen(paths.getDaemonSocketPath(), resolve));
  const verify = paths.secureDaemonDirectory;
  const spy = vi.spyOn(paths, 'secureDaemonDirectory').mockImplementationOnce(async () => {
    // Windows ACL verification can take longer than the daemon's network probe budget.
    await new Promise((resolve) => setTimeout(resolve, 200));
    await verify();
  });
  try {
    await expect(
      requestDaemon(
        paths.getDaemonSocketPath(),
        {
          id: 'health',
          method: 'status',
          params: {},
          protocolVersion: DAEMON_PROTOCOL_VERSION,
        },
        1000,
        100
      )
    ).resolves.toMatchObject({ result: 'healthy' });
  } finally {
    spy.mockRestore();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    key.fill(0);
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  }
});
