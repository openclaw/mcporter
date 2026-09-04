import fs from 'node:fs/promises';
import { expect, it } from 'vitest';
import { runDaemonHost } from '../src/daemon/host.js';
import { singletonFixture, fixtureResult } from './helpers/singleton.js';
it('serializes concurrent binds and repairs missing metadata without replacing the live generation', async () => {
  const f = await singletonFixture();
  try {
    const before = await f.client().status();
    await fs.unlink(f.paths.metadataPath);
    const hosts = await Promise.all([
      runDaemonHost({ ...f.paths, configPath: '/a' }),
      runDaemonHost({ ...f.paths, configPath: '/b' }),
    ]);
    const after = await f.client().status();
    expect(after?.generation).toBe(before?.generation);
    expect(JSON.parse(await fs.readFile(f.paths.metadataPath, 'utf8')).generation).toBe(before?.generation);
    await Promise.all(hosts.map((host) => host.close()));
    const results = await Promise.all([
      f.client().callTool({ server: 'fixture', tool: 'identity' }),
      f.client().callTool({ server: 'fixture', tool: 'identity' }),
    ]);
    expect(fixtureResult(results[0]).id).toBe(fixtureResult(results[1]).id);
  } finally {
    await f.close();
  }
});

it('settles concurrent host shutdowns before releasing the namespace', async () => {
  const f = await singletonFixture();
  try {
    await f.client().callTool({ server: 'fixture', tool: 'identity' });
    const closed = await Promise.allSettled([f.host.close(), f.host.close()]);
    expect(closed.map((result) => result.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(f.host.status().servers).toEqual([]);
    await expect(fs.stat(f.paths.metadataPath)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await f.close();
  }
});
