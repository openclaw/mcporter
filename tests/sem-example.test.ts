import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadServerDefinitions } from '../src/config.js';

const configPath = path.resolve('examples/sem/mcporter.json');

afterEach(() => vi.unstubAllEnvs());

describe('Sem example repository selection', () => {
  it('rejects an unset SEM_REPO before server startup', async () => {
    vi.stubEnv('SEM_REPO', undefined);
    await expect(loadServerDefinitions({ configPath })).rejects.toThrow(/cwd.*SEM_REPO/);
  });

  it('preserves an explicit checkout path, including spaces', async () => {
    const repo = path.resolve('checkout with spaces');
    vi.stubEnv('SEM_REPO', repo);
    const servers = await loadServerDefinitions({ configPath });
    expect(servers).toHaveLength(1);
    expect(servers[0]?.name).toBe('sem');
    expect(servers[0]?.command).toMatchObject({
      kind: 'stdio',
      command: 'npx',
      args: ['-y', '@ataraxy-labs/sem@0.27.0', 'mcp'],
      cwd: repo,
    });
  });
});
