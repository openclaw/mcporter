import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { BrowserOwner, BrowserOwnerConflict, canonicalChromeDefinitions } from '../src/daemon/browser-owner.js';
import { privateFixtureDirectory } from './helpers/private-directory.js';
import { connectionIdentity, effectiveDefinition } from '../src/daemon/connection-identity.js';
import { DaemonBroker } from '../src/daemon/broker.js';
import { createClientContext } from '../src/runtime/transport.js';

const generic = (name = 'fixture'): ServerDefinition => ({
  name,
  command: { kind: 'stdio', command: process.execPath, args: [], cwd: os.tmpdir() },
  env: { VALUE: 'one' },
  lifecycle: { mode: 'keep-alive' },
});
const chrome = (policy: 'require' | 'off' = 'require'): ServerDefinition => ({
  ...generic('chrome-devtools'),
  command: { kind: 'stdio', command: '/fixture/chrome-devtools-mcp', args: ['--autoConnect'], cwd: os.tmpdir() },
  chromeDevtoolsRelay: policy,
});

describe('single-user connection and owner contracts', () => {
  it('resolves canonical config placeholders in the OS-account context, not caller HOME', async () => {
    const root = await privateFixtureDirectory('mcp-canonical-');
    const saved = process.env.MCPORTER_DAEMON_DIR;
    const account = vi.spyOn(os, 'userInfo').mockReturnValue({ ...os.userInfo(), homedir: root });
    process.env.MCPORTER_DAEMON_DIR = path.join(root, '.mcporter');
    try {
      await fs.mkdir(process.env.MCPORTER_DAEMON_DIR, { mode: 0o700 });
      const executable = path.join(root, 'chrome-devtools-mcp');
      await fs.writeFile(executable, '# synthetic metadata-only fixture', { mode: 0o700 });
      await fs.writeFile(
        path.join(process.env.MCPORTER_DAEMON_DIR, 'mcporter.jsonc'),
        JSON.stringify({
          imports: [],
          mcpServers: {
            'chrome-devtools': {
              command: executable,
              args: ['--autoConnect'],
              cwd: '${HOME}',
            },
          },
        })
      );
      const [definition] = await canonicalChromeDefinitions();
      expect(definition?.command.kind === 'stdio' && definition.command.cwd).toBe(await fs.realpath(root));
      expect(definition?.env?.HOME).toBe(root);
    } finally {
      account.mockRestore();
      if (saved === undefined) delete process.env.MCPORTER_DAEMON_DIR;
      else process.env.MCPORTER_DAEMON_DIR = saved;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it('excludes aliases, descriptions, sources and view filters from generic identity', () => {
    expect(connectionIdentity(generic())).toBe(
      connectionIdentity({
        ...generic('other'),
        description: 'different',
        blockedTools: ['secret'],
        source: { kind: 'local', path: '/other/config' },
      })
    );
  });
  it('preserves meaningful env, cwd and authentication ownership', () => {
    const base = generic();
    expect(connectionIdentity(base)).not.toBe(connectionIdentity({ ...base, env: { VALUE: 'two' } }));
    expect(connectionIdentity(base)).not.toBe(
      connectionIdentity({
        ...base,
        command: { ...base.command, kind: 'stdio', command: process.execPath, args: [], cwd: '/' },
      })
    );
    expect(connectionIdentity({ ...base, auth: 'oauth' })).not.toBe(
      connectionIdentity({ ...generic('other'), auth: 'oauth' })
    );
  });
  it('canonicalizes effective env before identity without mutating shared process env', async () => {
    const def = generic();
    const a = await effectiveDefinition(def, { VALUE: 'discarded' });
    const b = await effectiveDefinition(def, { VALUE: 'also discarded' });
    expect(connectionIdentity(a)).toBe(connectionIdentity(b));
    expect(a.env).toEqual({ VALUE: 'one', PWD: a.command.kind === 'stdio' ? a.command.cwd : undefined });
  });
  it('normalizes inherited PWD to the actual launch cwd while retaining explicit PWD and arbitrary env', async () => {
    const a = await effectiveDefinition(generic(), { PWD: '/caller/a' });
    const b = await effectiveDefinition(generic(), { PWD: '/caller/b' });
    expect(connectionIdentity(a)).toBe(connectionIdentity(b));
    expect(a.env?.PWD).toBe(a.command.kind === 'stdio' ? a.command.cwd : undefined);
    const explicit = await effectiveDefinition(
      { ...generic(), env: { VALUE: 'one', PWD: '/explicit' } },
      { PWD: '/caller/a' }
    );
    expect(explicit.env?.PWD).toBe('/explicit');
    expect(connectionIdentity(explicit)).not.toBe(connectionIdentity(a));
    const other = await effectiveDefinition(generic(), { PWD: '/caller/a', ARBITRARY_INPUT: 'retained' });
    expect(connectionIdentity(other)).not.toBe(connectionIdentity(a));
  });
  it('ignores inherited shell nesting but preserves explicit server inputs', async () => {
    const direct = await effectiveDefinition(generic(), {});
    const shell = await effectiveDefinition(generic(), { SHLVL: '1' });
    const nested = await effectiveDefinition(generic(), { SHLVL: '3' });
    expect(connectionIdentity(shell)).toBe(connectionIdentity(direct));
    expect(connectionIdentity(nested)).toBe(connectionIdentity(direct));
    expect(shell.env?.SHLVL).toBeUndefined();
    const explicit = await effectiveDefinition({ ...generic(), env: { VALUE: 'one', SHLVL: '2' } }, { SHLVL: '1' });
    expect(explicit.env?.SHLVL).toBe('2');
    expect(connectionIdentity(explicit)).not.toBe(connectionIdentity(direct));
  });
  it('does not let unsupported canonical siblings poison a valid existing-browser owner', () => {
    const saved = process.env.MCPORTER_DAEMON_DIR;
    process.env.MCPORTER_DAEMON_DIR = path.join(os.userInfo().homedir, '.mcporter');
    try {
      const sibling = {
        ...chrome(),
        name: 'chrome-isolated',
        command: {
          ...chrome().command,
          kind: 'stdio' as const,
          command: '/fixture/chrome-devtools-mcp',
          args: [],
          cwd: os.tmpdir(),
        },
      };
      const owner = new BrowserOwner([chrome(), sibling]);
      expect(owner.reserve(chrome())).toEqual(chrome());
      expect(() => owner.reserve(sibling)).toThrow(BrowserOwnerConflict);
      expect(owner.reserve(chrome())).toEqual(chrome());
      const conflicting = new BrowserOwner([chrome(), chrome('off')]);
      expect(() => conflicting.reserve(chrome())).toThrow(BrowserOwnerConflict);
    } finally {
      if (saved === undefined) delete process.env.MCPORTER_DAEMON_DIR;
      else process.env.MCPORTER_DAEMON_DIR = saved;
    }
  });
  for (const reverse of [false, true])
    it(`global require rejects off/direct before an owner exists (reverse=${reverse})`, () => {
      const previous = process.env.MCPORTER_DAEMON_DIR;
      process.env.MCPORTER_DAEMON_DIR = path.join(os.userInfo().homedir, '.mcporter');
      const owner = new BrowserOwner([chrome()]);
      const direct = {
        ...chrome(),
        command: {
          ...chrome().command,
          kind: 'stdio' as const,
          command: '/fixture/chrome-devtools-mcp',
          args: ['--wsEndpoint', 'ws://127.0.0.1:9222/devtools/browser/synthetic'],
          cwd: os.tmpdir(),
        },
      };
      if (reverse) owner.reserve(chrome());
      expect(() => owner.reserve(chrome('off'))).toThrow(BrowserOwnerConflict);
      expect(() => owner.reserve(direct)).toThrow(BrowserOwnerConflict);
      owner.reserve(chrome());
      owner.reserve({ ...chrome(), name: 'alias' });
      expect(() => owner.reserve({ ...chrome(), env: { VALUE: 'changed' } })).toThrow(/canonical global/);
      process.env.MCPORTER_DAEMON_DIR = previous;
    });
  it('rejects programmatic existing-Chrome setup before discovery or executable resolution', async () => {
    await expect(
      createClientContext(chrome(), { info() {}, warn() {}, error() {} }, { name: 'fixture', version: '1' })
    ).rejects.toMatchObject({ code: 'browser_owner_conflict' });
  });
  it('rejects generation mismatch and view alias/tool violations without starting a transport', async () => {
    const broker = new DaemonBroker();
    const handle = broker.register({ definitions: [{ ...generic(), blockedTools: ['secret'] }] });
    await expect(
      broker.invoke({ id: 'a', method: 'callTool', params: { server: 'fixture', tool: 'secret' }, ...handle })
    ).rejects.toMatchObject({ code: 'tool_not_allowed' });
    await expect(
      broker.invoke({ id: 'a', method: 'listTools', params: { server: 'unregistered' }, ...handle })
    ).rejects.toMatchObject({ code: 'server_not_in_view' });
    await expect(
      broker.invoke({ id: 'a', method: 'listTools', params: { server: 'fixture' }, ...handle, generation: 'old' })
    ).rejects.toMatchObject({ code: 'daemon_generation_changed' });
    expect(broker.status().servers).toEqual([]);
    broker.release({ id: 'b', method: 'releaseView', params: {}, ...handle });
    expect(broker.status().views).toBe(0);
    await broker.close();
  });
  it('retains a single user locator despite different configs, HOME and XDG', async () => {
    const { resolveDaemonPaths } = await import('../src/daemon/client.js');
    expect(resolveDaemonPaths('/one/config')).toEqual(resolveDaemonPaths('/two/config'));
    const saved = {
      HOME: process.env.HOME,
      XDG_STATE_HOME: process.env.XDG_STATE_HOME,
      MCPORTER_DAEMON_DIR: process.env.MCPORTER_DAEMON_DIR,
    };
    try {
      delete process.env.MCPORTER_DAEMON_DIR;
      const first = resolveDaemonPaths('/one');
      process.env.HOME = '/nonexistent-synthetic-home';
      process.env.XDG_STATE_HOME = '/nonexistent-synthetic-state';
      expect(resolveDaemonPaths('/two')).toEqual(first);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
