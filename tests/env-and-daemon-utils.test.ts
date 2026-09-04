import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import {
  buildErrorResponse,
  ensureManaged,
  evictIdleServers,
  markActivity,
  type ServerActivity,
} from '../src/daemon/request-utils.js';
import { expandHome, resolveEnvPlaceholders, resolveEnvValue, withEnvOverrides } from '../src/env.js';
import type { Runtime } from '../src/runtime.js';

const daemonDefinition = (name: string, idleTimeoutMs?: number): ServerDefinition => ({
  name,
  command: { kind: 'stdio', command: 'node', args: [], cwd: process.cwd() },
  lifecycle: { mode: 'keep-alive', ...(idleTimeoutMs ? { idleTimeoutMs } : {}) },
});

describe('environment helpers', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('expands only supported home prefixes and coerces primitive env values', () => {
    expect(expandHome('~')).not.toBe('~');
    expect(expandHome('~someone/file')).toBe('~someone/file');
    expect(resolveEnvValue(42)).toBe('42');
  });

  it('resolves direct variables, defaults, empty values, and missing diagnostics', () => {
    process.env.MCPORTER_ENV_PRESENT = 'present';
    process.env.MCPORTER_ENV_EMPTY = '';
    expect(resolveEnvPlaceholders('$env:MCPORTER_ENV_PRESENT')).toBe('present');
    expect(resolveEnvValue('${MCPORTER_ENV_EMPTY:-fallback}')).toBe('fallback');
    expect(resolveEnvPlaceholders('${MCPORTER_ENV_EMPTY}')).toBe('');
    expect(() => resolveEnvPlaceholders('$env:MCPORTER_ENV_MISSING')).toThrow(
      "Environment variable 'MCPORTER_ENV_MISSING' is required"
    );
    expect(() => resolveEnvPlaceholders('${MISSING_Z}-${MISSING_A}')).toThrow('MISSING_A, MISSING_Z');
  });

  it('rejects unsupported braced env placeholders with supported alternatives', () => {
    expect(() => resolveEnvPlaceholders('Bearer ${env:MCPORTER_TOKEN}', { MCPORTER_TOKEN: 'secret' })).toThrow(
      "Unsupported environment placeholder '${env:MCPORTER_TOKEN}'. Use '${VAR}', '${VAR:-fallback}', or whole-value '$env:VAR'."
    );
    expect(() => resolveEnvValue('${env:MCPORTER_TOKEN}', { MCPORTER_TOKEN: 'secret' })).toThrow(
      'Unsupported environment placeholder'
    );
    expect(resolveEnvPlaceholders('Bearer literal env:MCPORTER_TOKEN')).toBe('Bearer literal env:MCPORTER_TOKEN');
  });

  it('applies only absent non-empty overrides and always restores them', async () => {
    process.env.MCPORTER_EXISTING = 'original';
    await expect(
      withEnvOverrides(
        { MCPORTER_EXISTING: 'replacement', MCPORTER_TEMP: 'value', MCPORTER_EMPTY_OVERRIDE: '' },
        async () => {
          expect(process.env.MCPORTER_EXISTING).toBe('original');
          expect(process.env.MCPORTER_TEMP).toBe('value');
          expect(process.env.MCPORTER_EMPTY_OVERRIDE).toBeUndefined();
          throw new Error('task failed');
        }
      )
    ).rejects.toThrow('task failed');
    expect(process.env.MCPORTER_TEMP).toBeUndefined();
    await expect(withEnvOverrides(undefined, async () => 'done')).resolves.toBe('done');
  });

  it('rejects unsupported placeholders before inherited env precedence', async () => {
    process.env.MCPORTER_EXISTING = 'original';

    await expect(
      withEnvOverrides({ MCPORTER_EXISTING: '${env:MCPORTER_EXISTING}' }, async () => 'unreachable')
    ).rejects.toThrow("Unsupported environment placeholder '${env:MCPORTER_EXISTING}'");
  });

  it.each([
    ['${env:MCPORTER_REQUIRED}', 'Unsupported environment placeholder'],
    ['$env:MCPORTER_REQUIRED', "Environment variable 'MCPORTER_REQUIRED' is required"],
  ])('cleans up earlier overrides when setup rejects %s', async (invalidValue, message) => {
    delete process.env.MCPORTER_TEMP;
    delete process.env.MCPORTER_REQUIRED;
    delete process.env.MCPORTER_INVALID;
    process.env.MCPORTER_EXISTING = 'original';
    const task = vi.fn();

    await expect(
      withEnvOverrides(
        { MCPORTER_EXISTING: 'replacement', MCPORTER_TEMP: 'temporary', MCPORTER_INVALID: invalidValue },
        task
      )
    ).rejects.toThrow(message);

    expect(task).not.toHaveBeenCalled();
    expect(process.env.MCPORTER_TEMP).toBeUndefined();
    expect(process.env.MCPORTER_INVALID).toBeUndefined();
    expect(process.env.MCPORTER_EXISTING).toBe('original');
  });
});

describe('daemon request utilities', () => {
  it('marks known and newly observed server activity', () => {
    const activity = new Map<string, ServerActivity>([['known', { connected: false }]]);
    markActivity('known', activity);
    markActivity('new', activity);
    expect(activity.get('known')).toMatchObject({ connected: true, lastUsedAt: expect.any(Number) });
    expect(activity.get('new')).toMatchObject({ connected: true, lastUsedAt: expect.any(Number) });
  });

  it('evicts only stale servers and records them disconnected even when close fails', async () => {
    const close = vi.fn().mockRejectedValue(new Error('already closed'));
    const runtime = { close } as unknown as Runtime;
    const managed = new Map([
      ['untimed', daemonDefinition('untimed')],
      ['unused', daemonDefinition('unused', 100)],
      ['recent', daemonDefinition('recent', 10_000)],
      ['stale', daemonDefinition('stale', 100)],
    ]);
    const activity = new Map<string, ServerActivity>([
      ['recent', { connected: true, lastUsedAt: Date.now() }],
      ['stale', { connected: true, lastUsedAt: Date.now() - 1_000 }],
    ]);

    await evictIdleServers(runtime, managed, activity);

    expect(close).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledWith('stale');
    expect(activity.get('stale')).toEqual({ connected: false });
    expect(activity.get('recent')?.connected).toBe(true);
  });

  it('validates managed names and preserves useful error messages', () => {
    const managed = new Map([['known', daemonDefinition('known')]]);
    expect(() => ensureManaged('known', managed)).not.toThrow();
    expect(() => ensureManaged('missing', managed)).toThrow("Server 'missing' is not managed");
    expect(buildErrorResponse('1', 'bad', new Error('specific'))).toMatchObject({
      id: '1',
      error: { code: 'bad', message: 'specific' },
    });
    expect(buildErrorResponse('2', 'bad', 'string failure').error?.message).toBe('string failure');
  });
});
