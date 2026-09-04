import { privateFixtureDirectory } from './helpers/private-directory.js';
import { expect, it } from 'vitest';
import { loadConfigSnapshot } from '../src/config.js';
import { DaemonBroker } from '../src/daemon/broker.js';
import fs from 'node:fs/promises';
it('client config snapshots stay independent of host startup and project idle settings', async () => {
  const root = await privateFixtureDirectory('mcp-snapshot-');
  try {
    const file = `${root}/config.json`;
    await fs.writeFile(file, JSON.stringify({ imports: [], daemonIdleTimeoutMs: 1, mcpServers: {} }));
    const snapshot = await loadConfigSnapshot({ configPath: file });
    const b = new DaemonBroker();
    b.register({ definitions: snapshot.servers });
    expect(snapshot.daemon.idleTimeoutMs).toBe(1);
    expect(b.status().views).toBe(1);
    expect(b.status().servers).toEqual([]);
    await b.close();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
