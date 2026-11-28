import net from 'node:net';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { authenticateServer, daemonKey, requestDaemon, SocketFrames } from '../src/daemon/socket-rpc.js';
import { getDaemonSocketPath, secureDaemonDirectory } from '../src/daemon/paths.js';
import { privateFixtureDirectory } from './helpers/private-directory.js';
import { DAEMON_PROTOCOL_VERSION, type DaemonRequest } from '../src/daemon/protocol.js';
let root: string | undefined, server: net.Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  vi.unstubAllEnvs();
  if (root) await fs.rm(root, { recursive: true, force: true });
  server = undefined;
});
async function fixture(url: string) {
  root = await fs.realpath(await privateFixtureDirectory('mcp-url-'));
  vi.stubEnv('MCPORTER_DAEMON_DIR', root);
  await secureDaemonDirectory();
  const key = await daemonKey();
  server = net.createServer((socket) => {
    void (async () => {
      const frames = new SocketFrames(socket);
      await authenticateServer(frames, key);
      const request = (await frames.read()) as DaemonRequest;
      frames.write({ type: 'authorization', id: request.id, authorizationUrl: url, open: true });
      frames.write({ type: 'progress', id: request.id });
      setTimeout(() => {
        frames.write({ id: request.id, ok: true, result: 'complete' });
        socket.end();
      }, 30);
    })().catch(() => socket.destroy());
  });
  await new Promise<void>((resolve) => server!.listen(getDaemonSocketPath(), resolve));
}
it('delivers authorization URL before final result through the authenticated request connection', async () => {
  await fixture('https://example.test/authorize?state=synthetic');
  const events: string[] = [];
  const value = await requestDaemon(
    getDaemonSocketPath(),
    { id: randomUUID(), method: 'listTools', params: { server: 'fixture' }, protocolVersion: DAEMON_PROTOCOL_VERSION },
    1000,
    2000,
    (url, open) => {
      events.push(url);
      expect(open).toBe(true);
    }
  );
  events.push(value.result as string);
  expect(events).toEqual(['https://example.test/authorize?state=synthetic', 'complete']);
});
it('rejects file URLs instead of opening a local file', async () => {
  await fixture('file:///private/secret');
  const opener = vi.fn();
  await expect(
    requestDaemon(
      getDaemonSocketPath(),
      { id: randomUUID(), method: 'status', params: {}, protocolVersion: DAEMON_PROTOCOL_VERSION },
      1000,
      2000,
      opener
    )
  ).rejects.toThrow('Invalid daemon authorization URL');
  expect(opener).not.toHaveBeenCalled();
});
