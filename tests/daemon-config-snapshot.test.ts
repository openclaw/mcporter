import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ loadConfigLayers: vi.fn() }));

vi.mock('../src/config/read-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config/read-config.js')>();
  mocks.loadConfigLayers.mockImplementation(actual.loadConfigLayers);
  return { ...actual, loadConfigLayers: mocks.loadConfigLayers };
});

import { loadDaemonRuntimeState } from '../src/daemon/host.js';

describe('daemon config snapshot', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    mocks.loadConfigLayers.mockClear();
    await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
  });

  it('loads config layers once for daemon policy and runtime definitions', async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-daemon-snapshot-'));
    tempDirs.push(rootDir);
    const configPath = path.join(rootDir, 'mcporter.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        daemonIdleTimeoutMs: 12_345,
        imports: [],
        mcpServers: {
          local: { command: 'node', args: ['server.js'] },
        },
      })
    );

    const { daemonConfig, runtime } = await loadDaemonRuntimeState({ configPath, rootDir });
    expect(mocks.loadConfigLayers).toHaveBeenCalledOnce();
    expect(daemonConfig).toEqual({ idleTimeoutMs: 12_345 });
    expect(runtime.listServers()).toEqual(['local']);
    await runtime.close();
  });
});
