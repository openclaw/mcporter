import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';

const AMBIENT_VAULT_SENTINEL = '{"sentinel":"must-not-change"}\n';

export interface IsolatedTestHome {
  homeDir: string;
  vaultPath: string;
  ambientVaultPath: string;
  assertAmbientVaultUntouched(): Promise<void>;
  cleanup(): Promise<void>;
}

/**
 * Isolates both os.homedir() and every XDG root. The synthetic ambient vault
 * catches regressions where a suite clears HOME but accidentally leaves an
 * inherited XDG_DATA_HOME pointing at real credentials.
 */
export async function createIsolatedTestHome(prefix: string): Promise<IsolatedTestHome> {
  const originalEnv = { ...process.env };
  const ambientRoot = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-ambient-`));
  const ambientVaultPath = path.join(ambientRoot, 'mcporter', 'credentials.json');
  await fs.mkdir(path.dirname(ambientVaultPath), { recursive: true });
  await fs.writeFile(ambientVaultPath, AMBIENT_VAULT_SENTINEL, { encoding: 'utf8', mode: 0o600 });

  // Model a developer shell that already has XDG_DATA_HOME configured before
  // the suite installs its isolated HOME/XDG environment.
  process.env.XDG_DATA_HOME = ambientRoot;

  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), `${prefix}-home-`));
  const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
  process.env.HOME = homeDir;
  process.env.USERPROFILE = homeDir;
  process.env.XDG_CONFIG_HOME = path.join(homeDir, '.config');
  process.env.XDG_DATA_HOME = path.join(homeDir, '.local', 'share');
  process.env.XDG_STATE_HOME = path.join(homeDir, '.local', 'state');
  process.env.XDG_CACHE_HOME = path.join(homeDir, '.cache');

  const assertAmbientVaultUntouched = async (): Promise<void> => {
    const contents = await fs.readFile(ambientVaultPath, 'utf8');
    if (contents !== AMBIENT_VAULT_SENTINEL) {
      throw new Error(`OAuth test touched ambient credentials: ${ambientVaultPath}`);
    }
  };

  return {
    homeDir,
    vaultPath: path.join(process.env.XDG_DATA_HOME, 'mcporter', 'credentials.json'),
    ambientVaultPath,
    assertAmbientVaultUntouched,
    cleanup: async () => {
      try {
        await assertAmbientVaultUntouched();
      } finally {
        homedirSpy.mockRestore();
        process.env = { ...originalEnv };
        await Promise.all([
          fs.rm(homeDir, { recursive: true, force: true }),
          fs.rm(ambientRoot, { recursive: true, force: true }),
        ]);
      }
    },
  };
}
