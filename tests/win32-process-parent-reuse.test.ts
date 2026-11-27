import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  rows: [
    { pid: 101, parent: 0, born: 300 },
    { pid: 102, parent: 101, born: 200 },
    { pid: 103, parent: 102, born: 400 },
  ],
  cursors: new Map<bigint, number>(),
  serial: 10000n,
  error: 0,
  closed: [] as bigint[],
}));
vi.mock('koffi', () => {
  const decode = Object.assign(() => 700n, { string16: () => 'S-1-5-21-1000' });
  const calls: Record<string, (...args: any[]) => unknown> = {
    GetCurrentProcess: () => 999n,
    OpenProcess: (_access, _inherit, pid) => BigInt(pid),
    WaitForSingleObject: () => 258,
    GetLastError: () => state.error,
    GetProcessTimes: (handle, created) => {
      created.writeBigUInt64LE(
        116444736000000000n + BigInt(state.rows.find((row) => BigInt(row.pid) === handle)!.born)
      );
      return 1;
    },
    OpenProcessToken: (_handle, _access, token) => {
      token[0] = 800n;
      return 1;
    },
    GetTokenInformation: (_handle, _type, buffer, _size, needed) => {
      needed[0] = 16;
      return buffer ? 1 : 0;
    },
    ConvertSidToStringSidW: (_sid, text) => {
      text[0] = 900n;
      return 1;
    },
    LocalFree: () => null,
    CloseHandle: (handle) => {
      state.closed.push(handle);
      return 1;
    },
    CreateToolhelp32Snapshot: () => {
      const handle = ++state.serial;
      state.cursors.set(handle, 0);
      return handle;
    },
    Process32FirstW: (handle, entry) => {
      Object.assign(entry, state.rows[0]);
      state.cursors.set(handle, 0);
      return 1;
    },
    Process32NextW: (handle, entry) => {
      const index = state.cursors.get(handle)! + 1;
      state.cursors.set(handle, index);
      if (index === state.rows.length) {
        state.error = 18;
        return 0;
      }
      Object.assign(entry, state.rows[index]);
      return 1;
    },
  };
  return {
    default: {
      load: () => ({ func: (signature: string) => calls[/([A-Za-z0-9_]+)\s*\(/.exec(signature)![1]!] ?? (() => 1) }),
      struct: () => 'Entry',
      sizeof: () => 568,
      array: () => 'array',
      decode,
    },
  };
});
import { observeWindowsProcesses } from '../src/daemon/win32-native.js';
import { ownedProcessTree, processInventory } from '../src/daemon/process-retirement.js';
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
beforeEach(() => {
  state.closed.length = 0;
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
});
it('rejects a stale parent edge while preserving the independently requested process and its real descendants', async () => {
  const [a, b] = await Promise.all([ownedProcessTree(101), ownedProcessTree(102)]);
  expect(a.map((row) => row.pid)).toEqual([101]);
  expect(b.map((row) => row.pid)).toEqual([102, 103]);
  expect(state.closed).toEqual(expect.arrayContaining([101n, 102n, 103n]));
});
it('keeps explicit process identity available when another caller observes the stale parent tree', async () => {
  const [tree, inventory] = await Promise.all([ownedProcessTree(101), processInventory([102])]);
  expect(tree.map((row) => row.pid)).toEqual([101]);
  expect(inventory.processes.find((row) => row.pid === 102)).toMatchObject({
    pid: 102,
    owner: 'S-1-5-21-1000',
    born: expect.any(String),
    parent: 0,
  });
});
it('keeps ordinary parent links whose creation order supports ownership', async () => {
  const inventory = await observeWindowsProcesses([102], [102]);
  expect(inventory.processes.find((row) => row.pid === 103)?.parent).toBe(102);
});
