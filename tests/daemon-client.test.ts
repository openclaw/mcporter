import { privateFixtureDirectory } from './helpers/private-directory.js';
import fs from 'node:fs/promises';
import net from 'node:net';
import { expect, it } from 'vitest';
import { DaemonClient, resolveDaemonPaths } from '../src/daemon/client.js';
import { secureDaemonDirectory } from '../src/daemon/paths.js';
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
    expect(captured).toContain('hello');
    expect(captured).not.toContain('synthetic-secret');
    expect(captured).not.toContain('registerView');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.env.MCPORTER_DAEMON_DIR = previous;
    await fs.rm(root, { recursive: true, force: true });
  }
});
