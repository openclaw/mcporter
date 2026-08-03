import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };
const command = { kind: 'stdio' as const, command: 'custom-mcp', args: [], cwd: process.cwd() };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

describe('keep-alive environment overrides', () => {
  it('forces named servers into keep-alive mode', async () => {
    process.env.MCPORTER_KEEPALIVE = ' custom , unused ';
    const { resolveLifecycle } = await import('../src/lifecycle.js');
    expect(resolveLifecycle('custom', undefined, command)).toEqual({ mode: 'keep-alive' });
  });

  it('forces default keep-alive servers off by canonical command name', async () => {
    process.env.MCPORTER_DISABLE_KEEPALIVE = 'chrome-devtools';
    const { resolveLifecycle } = await import('../src/lifecycle.js');
    const chrome = { ...command, args: ['chrome-devtools-mcp@latest'] };
    expect(resolveLifecycle('browser', undefined, chrome)).toBeUndefined();
  });

  it('supports wildcard opt-in', async () => {
    process.env.MCPORTER_KEEPALIVE = '*';
    const { resolveLifecycle } = await import('../src/lifecycle.js');
    expect(resolveLifecycle('anything', undefined, command)).toEqual({ mode: 'keep-alive' });
  });
});
