import { describe, expect, it } from 'vitest';
import type { CommandSpec } from '../src/config-schema.js';
import { canonicalKeepAliveName, isKeepAliveServer, keepAliveIdleTimeout, resolveLifecycle } from '../src/lifecycle.js';

const CHROME_COMMAND: CommandSpec = {
  kind: 'stdio',
  command: 'npx',
  args: ['-y', 'chrome-devtools-mcp@latest', '--browserUrl', String.raw`\${CHROME_DEVTOOLS_URL}`],
  cwd: process.cwd(),
};

const CHROME_COMMAND_ENV: CommandSpec = {
  kind: 'stdio',
  command: 'npx',
  args: ['-y', 'chrome-devtools-mcp@latest', '--browserUrl', '$env:CHROME_DEVTOOLS_URL'],
  cwd: process.cwd(),
};

const CLOUDBASE_NPX_COMMAND: CommandSpec = {
  kind: 'stdio',
  command: 'npx',
  args: ['-y', '@cloudbase/cloudbase-mcp@latest'],
  cwd: process.cwd(),
};

const CLOUDBASE_BIN_COMMAND: CommandSpec = {
  kind: 'stdio',
  command: 'cloudbase-mcp',
  args: [],
  cwd: process.cwd(),
};

describe('resolveLifecycle', () => {
  it('forces chrome-devtools placeholder runs to be ephemeral', () => {
    const lifecycle = resolveLifecycle('chrome-devtools', undefined, CHROME_COMMAND);
    expect(lifecycle?.mode).toBe('ephemeral');
  });

  it('forces chrome-devtools $env placeholder runs to be ephemeral', () => {
    const lifecycle = resolveLifecycle('chrome-devtools', undefined, CHROME_COMMAND_ENV);
    expect(lifecycle?.mode).toBe('ephemeral');
  });

  it('auto-enables keep-alive for CloudBase MCP package commands', () => {
    const lifecycle = resolveLifecycle('cloudbase', undefined, CLOUDBASE_NPX_COMMAND);
    expect(lifecycle?.mode).toBe('keep-alive');
  });

  it('auto-enables keep-alive for CloudBase MCP binary commands', () => {
    const lifecycle = resolveLifecycle('tcb', undefined, CLOUDBASE_BIN_COMMAND);
    expect(lifecycle?.mode).toBe('keep-alive');
  });

  it('honors explicit ephemeral lifecycle for CloudBase MCP commands', () => {
    const lifecycle = resolveLifecycle('cloudbase', 'ephemeral', CLOUDBASE_NPX_COMMAND);
    expect(lifecycle?.mode).toBe('ephemeral');
  });

  it('coerces explicit lifecycle objects and ignores invalid idle timeouts', () => {
    expect(resolveLifecycle('custom', { mode: 'keep-alive', idleTimeoutMs: 1250.9 }, CLOUDBASE_NPX_COMMAND)).toEqual({
      mode: 'keep-alive',
      idleTimeoutMs: 1250,
    });
    expect(resolveLifecycle('custom', { mode: 'keep-alive', idleTimeoutMs: -1 }, CLOUDBASE_NPX_COMMAND)).toEqual({
      mode: 'keep-alive',
    });
    expect(resolveLifecycle('custom', { mode: 'ephemeral' }, CLOUDBASE_NPX_COMMAND)).toEqual({ mode: 'ephemeral' });
    expect(
      resolveLifecycle('custom', 'invalid' as never, { kind: 'http', url: new URL('https://example.com') })
    ).toBeUndefined();
  });

  it('identifies canonical commands and exposes keep-alive predicates', () => {
    expect(canonicalKeepAliveName({ kind: 'http', url: new URL('https://example.com') })).toBeUndefined();
    expect(canonicalKeepAliveName(CLOUDBASE_NPX_COMMAND)).toBe('cloudbase');
    expect(isKeepAliveServer(undefined)).toBe(false);
    expect(isKeepAliveServer({ name: 'x', command: CLOUDBASE_NPX_COMMAND, lifecycle: { mode: 'keep-alive' } })).toBe(
      true
    );
    expect(
      keepAliveIdleTimeout({
        name: 'x',
        command: CLOUDBASE_NPX_COMMAND,
        lifecycle: { mode: 'keep-alive', idleTimeoutMs: 500 },
      })
    ).toBe(500);
    expect(
      keepAliveIdleTimeout({ name: 'x', command: CLOUDBASE_NPX_COMMAND, lifecycle: { mode: 'ephemeral' } })
    ).toBeUndefined();
  });
});
