import fs from 'node:fs/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { isBootIdentity, readBootIdentity } from '../src/daemon/boot-identity.js';

afterEach(() => vi.restoreAllMocks());

it.skipIf(process.platform !== 'linux' && process.platform !== 'darwin')(
  'reads a stable native kernel boot UUID',
  async () => {
    const boot = await readBootIdentity();
    expect(isBootIdentity(boot)).toBe(true);
    expect(await readBootIdentity()).toEqual(boot);
    expect(boot?.platform).toBe(process.platform);
  }
);

it('reads the Linux kernel UUID and normalizes its spelling', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  const read = vi.spyOn(fs, 'readFile').mockResolvedValue('AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE\n');
  expect(await readBootIdentity()).toEqual({ platform: 'linux', id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' });
  expect(read).toHaveBeenCalledWith('/proc/sys/kernel/random/boot_id', 'utf8');
});

it('does not invent boot evidence when the kernel query fails or returns malformed output', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
  const read = vi.spyOn(fs, 'readFile').mockRejectedValue(new Error('denied'));
  expect(await readBootIdentity()).toBeUndefined();
  read.mockResolvedValue('not a boot UUID');
  expect(await readBootIdentity()).toBeUndefined();
});

it.each(['win32', 'freebsd'] as const)('explicitly leaves %s recovery unsupported', async (platform) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
  expect(await readBootIdentity()).toBeUndefined();
});

it.each([null, {}, { platform: 'win32', id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' }, { platform: 'linux', id: 1 }])(
  'rejects invalid boot evidence %j',
  (value) => expect(isBootIdentity(value)).toBe(false)
);
