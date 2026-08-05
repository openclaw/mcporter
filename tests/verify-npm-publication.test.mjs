import { describe, expect, it, vi } from 'vitest';
import {
  NpmPublicationMismatchError,
  NpmPublicationTimeoutError,
  verifyNpmPublication,
} from '../scripts/verify-npm-publication.mjs';

const packageName = 'mcporter';
const version = '0.13.0';
const integrity = 'sha512-protected-release';

function successfulView(overrides = {}) {
  return vi.fn(async (_spec, field) => {
    if (field === 'version') return overrides.version ?? version;
    if (field === 'dist.integrity') return overrides.integrity ?? integrity;
    if (field === 'dist-tags.latest') return overrides.latest ?? version;
    throw new Error(`unexpected npm view field: ${field}`);
  });
}

describe('verifyNpmPublication', () => {
  it('backs off while npm propagates incomplete metadata', async () => {
    let clock = 0;
    const sleep = vi.fn(async (delayMs) => {
      clock += delayMs;
    });
    const view = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(version)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(version)
      .mockResolvedValueOnce(integrity)
      .mockResolvedValueOnce(version);

    await expect(
      verifyNpmPublication({
        packageName,
        version,
        expectedIntegrity: integrity,
        timeoutMs: 60_000,
        initialDelayMs: 1_000,
        maxDelayMs: 4_000,
        view,
        sleep,
        now: () => clock,
        log: vi.fn(),
      })
    ).resolves.toEqual({ version, integrity, latest: version });

    expect(sleep.mock.calls.map(([delayMs]) => delayMs)).toEqual([1_000, 2_000]);
  });

  it('fails immediately when the expected integrity is mutated', async () => {
    const sleep = vi.fn();

    await expect(
      verifyNpmPublication({
        packageName,
        version,
        expectedIntegrity: `${integrity}-mutated`,
        view: successfulView(),
        sleep,
        log: vi.fn(),
      })
    ).rejects.toThrow(NpmPublicationMismatchError);

    expect(sleep).not.toHaveBeenCalled();
  });

  it('fails immediately when the latest dist-tag is mutated', async () => {
    const sleep = vi.fn();

    await expect(
      verifyNpmPublication({
        packageName,
        version,
        expectedIntegrity: integrity,
        view: successfulView({ latest: '0.12.4' }),
        sleep,
        log: vi.fn(),
      })
    ).rejects.toThrow(NpmPublicationMismatchError);

    expect(sleep).not.toHaveBeenCalled();
  });

  it('times out when the version never propagates', async () => {
    let clock = 0;
    const sleep = vi.fn(async (delayMs) => {
      clock += delayMs;
    });

    await expect(
      verifyNpmPublication({
        packageName,
        version,
        expectedIntegrity: integrity,
        timeoutMs: 3_000,
        initialDelayMs: 1_000,
        maxDelayMs: 2_000,
        view: vi.fn().mockResolvedValue(null),
        sleep,
        now: () => clock,
        log: vi.fn(),
      })
    ).rejects.toThrow(NpmPublicationTimeoutError);

    expect(sleep.mock.calls.map(([delayMs]) => delayMs)).toEqual([1_000, 2_000]);
  });
});
