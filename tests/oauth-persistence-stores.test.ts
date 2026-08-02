import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirectoryPersistence } from '../src/oauth-persistence-stores.js';

describe('OAuth persistence store snapshots', () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it('reconciles a directory server URL once when reading all credentials', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-snapshot-'));
    tempRoots.push(root);
    const serverUrl = 'https://example.com/mcp';
    const serverUrlPath = path.join(root, 'server_url.txt');
    await Promise.all([
      fs.writeFile(serverUrlPath, serverUrl),
      fs.writeFile(path.join(root, 'tokens.json'), JSON.stringify({ access_token: 'token', token_type: 'Bearer' })),
      fs.writeFile(path.join(root, 'client.json'), JSON.stringify({ client_id: 'client' })),
      fs.writeFile(path.join(root, 'code_verifier.txt'), 'verifier'),
      fs.writeFile(path.join(root, 'state.txt'), JSON.stringify('state')),
    ]);
    const readFile = vi.spyOn(fs, 'readFile');
    const persistence = new DirectoryPersistence(root, undefined, serverUrl);

    const snapshot = await persistence.readSnapshot();

    expect(snapshot.tokens?.access_token).toBe('token');
    expect(snapshot.clientInfo?.client_id).toBe('client');
    expect(snapshot.codeVerifier).toBe('verifier');
    expect(snapshot.state).toBe('state');
    expect(readFile.mock.calls.filter(([file]) => file === serverUrlPath)).toHaveLength(1);
  });
});
