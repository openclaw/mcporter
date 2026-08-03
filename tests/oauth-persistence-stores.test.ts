import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import {
  CompositePersistence,
  createOAuthPersistenceStores,
  DirectoryPersistence,
} from '../src/oauth-persistence-stores.js';

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

  it('round-trips every directory-backed OAuth session field and clears it', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-fields-'));
    tempRoots.push(root);
    const persistence = new DirectoryPersistence(root);

    await persistence.saveTokens({ access_token: 'token', token_type: 'Bearer' });
    await persistence.saveClientInfo({ client_id: 'client' });
    await persistence.saveCodeVerifier(' verifier ');
    await persistence.saveState('state');
    await persistence.saveDiscoveryState({ resourceMetadataUrl: 'https://example.com/resource' } as never);
    await persistence.saveAuthorizationServerUrl(' https://auth.example.com ');
    await persistence.saveResourceUrl(' https://resource.example.com ');

    expect(persistence.describe()).toBe(root);
    await expect(persistence.readSnapshot()).resolves.toMatchObject({
      tokens: { access_token: 'token' },
      clientInfo: { client_id: 'client' },
      codeVerifier: 'verifier',
      state: 'state',
      authorizationServerUrl: 'https://auth.example.com',
      resourceUrl: 'https://resource.example.com',
    });

    await persistence.clear('all');
    await expect(persistence.readSnapshot()).resolves.toEqual({});
  });

  it('ignores corrupt credential JSON while leaving OAuth state fail-closed', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-corrupt-'));
    tempRoots.push(root);
    await fs.writeFile(path.join(root, 'tokens.json'), '{bad');
    await fs.writeFile(path.join(root, 'client.json'), '{bad');
    await fs.writeFile(path.join(root, 'state.txt'), '{bad');
    const debug = vi.fn();
    const persistence = new DirectoryPersistence(root, { debug } as never);

    await expect(persistence.readTokens()).resolves.toBeUndefined();
    await expect(persistence.readClientInfo()).resolves.toBeUndefined();
    await expect(persistence.readState()).rejects.toThrow();
    expect(debug).toHaveBeenCalledTimes(2);
  });

  it('composes stores with first-present precedence and stable recovery snapshots', async () => {
    const firstRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-first-'));
    const secondRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-second-'));
    tempRoots.push(firstRoot, secondRoot);
    const first = new DirectoryPersistence(firstRoot);
    const second = new DirectoryPersistence(secondRoot);
    await second.saveTokens({ access_token: 'second', token_type: 'Bearer' });
    await second.saveClientInfo({ client_id: 'second-client' });
    await second.saveResourceUrl('https://resource.example.com');
    const composite = new CompositePersistence([first, second]);

    expect(composite.describe()).toBe(`${firstRoot} + ${secondRoot}`);
    await expect(composite.readSnapshot()).resolves.toMatchObject({
      tokens: { access_token: 'second' },
      clientInfo: { client_id: 'second-client' },
      resourceUrl: 'https://resource.example.com',
    });
    await expect(composite.readAuthorizationServerUrl()).resolves.toBeUndefined();
  });

  it('migrates complete legacy session state into the vault', async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-oauth-legacy-'));
    const data = path.join(home, 'data');
    tempRoots.push(home);
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(home);
    const previousData = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = data;
    const definition: ServerDefinition = {
      name: 'legacy-service',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
    };
    const legacy = new DirectoryPersistence(path.join(home, '.mcporter', definition.name));
    await legacy.saveCodeVerifier('verifier');
    await legacy.saveState('state');
    await legacy.saveDiscoveryState({ authorizationServerUrl: 'https://auth.example.com' } as never);
    await legacy.saveAuthorizationServerUrl('https://auth.example.com');
    await legacy.saveResourceUrl('https://example.com/mcp');

    try {
      const persistence = await createOAuthPersistenceStores(definition);
      await expect(persistence.readSnapshot()).resolves.toMatchObject({
        codeVerifier: 'verifier',
        state: 'state',
        authorizationServerUrl: 'https://auth.example.com',
        resourceUrl: 'https://example.com/mcp',
      });
    } finally {
      homedir.mockRestore();
      if (previousData === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousData;
    }
  });
});
