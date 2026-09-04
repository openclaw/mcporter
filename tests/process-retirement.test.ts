import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  return { ...actual, execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }) };
});
vi.mock('../src/chrome-devtools-relay-handoff.js', () => ({ resolveSystemPowerShellPath: () => 'system-powershell' }));

const owner = 'S-1-5-21-123';
const root = { pid: 101, parent: 50, owner, born: '2026-09-04T12:00:00.0000000Z' };
const child = { ...root, pid: 102, parent: 101 };
const envelope = (processes: unknown[]) => JSON.stringify({ version: 1, owner, processes });

beforeEach(() => {
  vi.resetModules();
  execute.mockReset();
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
});
afterEach(() => vi.restoreAllMocks());

it.each(['', ' ', '{', 'null', '[]', '{}', '{"owner":"S-1-5-21-123","processes":[]}'])(
  'blocks retirement on malformed or incomplete inventory %j without echoing output',
  async (stdout) => {
    execute.mockResolvedValue({ stdout });
    const { awaitRetirement } = await import('../src/daemon/process-retirement.js');
    await expect(awaitRetirement([root])).rejects.toThrow(/Windows process observation.*retirement remains blocked/);
  }
);

it.each([
  { ...root, pid: '101' },
  { ...root, parent: -1 },
  { ...root, born: '' },
  { ...root, owner: 'not-a-sid' },
  null,
])('rejects malformed process rows', async (row) => {
  execute.mockResolvedValue({ stdout: envelope([row]) });
  const { awaitRetirement } = await import('../src/daemon/process-retirement.js');
  await expect(awaitRetirement([root])).rejects.toThrow(/Windows process observation/);
});

it('accepts explicit empty inventory and UTF-8 BOM, but requires a root for ownership capture', async () => {
  execute.mockResolvedValue({ stdout: `\uFEFF${envelope([])}\r\n` });
  const { awaitRetirement, ownedProcessTree } = await import('../src/daemon/process-retirement.js');
  await expect(awaitRetirement([root])).resolves.toBeUndefined();
  await expect(ownedProcessTree(root.pid)).rejects.toThrow(/ownership could not be verified/);
});

it('rejects duplicate PIDs instead of selecting a convenient identity', async () => {
  execute.mockResolvedValue({ stdout: envelope([root, { ...root, born: 'different' }]) });
  const { awaitRetirement } = await import('../src/daemon/process-retirement.js');
  await expect(awaitRetirement([root])).rejects.toThrow(/Windows process observation/);
});

it.each([{ owner: null }, { born: null }, { owner: 'S-1-5-21-456' }])(
  'does not confuse unverified process identity with absence: %j',
  async (change) => {
    execute.mockResolvedValue({ stdout: envelope([{ ...root, ...change }]) });
    const { awaitRetirement, ownedProcessTree } = await import('../src/daemon/process-retirement.js');
    await expect(awaitRetirement([root])).rejects.toThrow(/ownership could not be verified/);
    await expect(ownedProcessTree(root.pid)).rejects.toThrow(/ownership could not be verified/);
  }
);

it('waits for every owned child, while distinguishing a reused PID by its start identity', async () => {
  execute.mockResolvedValueOnce({ stdout: envelope([child]) }).mockResolvedValueOnce({ stdout: envelope([]) });
  const { awaitRetirement } = await import('../src/daemon/process-retirement.js');
  await awaitRetirement([root, child]);
  expect(execute).toHaveBeenCalledTimes(2);
  execute.mockResolvedValue({ stdout: envelope([{ ...root, born: '2026-09-04T12:00:01.0000000Z' }]) });
  await expect(awaitRetirement([root])).resolves.toBeUndefined();
});

it('refuses an unverified descendant even when its root is owned', async () => {
  execute.mockResolvedValue({ stdout: envelope([root, { ...child, owner: null }]) });
  const { ownedProcessTree } = await import('../src/daemon/process-retirement.js');
  await expect(ownedProcessTree(root.pid)).rejects.toThrow(/child ownership could not be verified/);
});

it('batches concurrent captures before querying, filters owners to the selected tree, and targets retirement PIDs', async () => {
  execute.mockResolvedValue({ stdout: envelope([root, child]) });
  const { ownedProcessTree, awaitRetirement } = await import('../src/daemon/process-retirement.js');
  const values = await Promise.all([ownedProcessTree(root.pid), ownedProcessTree(root.pid)]);
  expect(values).toEqual([
    [root, child],
    [root, child],
  ]);
  expect(execute).toHaveBeenCalledTimes(1);
  const script = Buffer.from(execute.mock.calls[0]![1].at(-1), 'base64').toString('utf16le');
  expect(script).toContain('[Console]::OutputEncoding');
  expect(script).toContain('SELECT Handle,ProcessId,ParentProcessId,CreationDate FROM Win32_Process');
  expect(script).not.toContain('Get-CimInstance');
  expect(script.indexOf('if (-not $selected.ContainsKey')).toBeLessThan(script.indexOf("'GetOwnerSid'"));
  expect(script).not.toMatch(/CommandLine|ExecutablePath/);
  execute.mockResolvedValue({ stdout: envelope([]) });
  await awaitRetirement([root, child]);
  const poll = Buffer.from(execute.mock.calls[1]![1].at(-1), 'base64').toString('utf16le');
  expect(poll).toContain('WHERE ProcessId=101 OR ProcessId=102');
  expect(execute.mock.calls[1]![2]).toMatchObject({ timeout: 5000, encoding: 'utf8', windowsHide: true });
});

it('does not let a later caller reuse a snapshot already in flight', async () => {
  let finish!: (value: { stdout: string }) => void;
  execute.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  execute.mockResolvedValue({ stdout: envelope([]) });
  const { awaitRetirement } = await import('../src/daemon/process-retirement.js');
  const first = awaitRetirement([root]);
  await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
  const later = awaitRetirement([root]);
  await later;
  expect(execute).toHaveBeenCalledTimes(2);
  finish({ stdout: envelope([]) });
  await first;
});

it('redacts command output and process arguments on execution failure', async () => {
  execute.mockRejectedValue(Object.assign(new Error('sensitive argv and stdout'), { stderr: 'credential' }));
  const { ownedProcessTree } = await import('../src/daemon/process-retirement.js');
  await expect(ownedProcessTree(root.pid)).rejects.toThrow(
    /^Windows process observation failed; retirement remains blocked\./
  );
});

it('bounds request batches without omitting any retirement target', async () => {
  execute.mockResolvedValue({ stdout: envelope([]) });
  const { awaitRetirement } = await import('../src/daemon/process-retirement.js');
  await awaitRetirement(Array.from({ length: 257 }, (_, index) => ({ ...root, pid: index + 1 })));
  expect(execute).toHaveBeenCalledTimes(2);
  const last = Buffer.from(execute.mock.calls[1]![1].at(-1), 'base64').toString('utf16le');
  expect(last).toContain('WHERE ProcessId=257');
});

it('accepts signed POSIX owners and normalizes start-time whitespace without losing an existing identity', async () => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  execute.mockResolvedValueOnce({
    stdout: '101 50 123 Fri Sep 4 12:00:00 2026    \n653 1 -2 Tue Sep 1 13:56:59 2026    \n',
  });
  const { processInventory, awaitRetirement } = await import('../src/daemon/process-retirement.js');
  const inventory = await processInventory([101]);
  const identity = { pid: 101, parent: 50, owner: '123', born: 'Fri Sep 4 12:00:00 2026' };
  expect(inventory.processes[0]).toEqual(identity);
  expect(inventory.processes[1]?.owner).toBe('-2');
  execute.mockResolvedValueOnce({ stdout: '101 50 123 Fri Sep 4 12:00:00 2026    \n' });
  execute.mockResolvedValueOnce({ stdout: '653 1 -2 Tue Sep 1 13:56:59 2026    \n' });
  await awaitRetirement([{ ...identity, born: `${identity.born}    ` }]);
  expect(execute).toHaveBeenCalledTimes(3);
});

it.each(['', 'malformed'])('blocks retirement on invalid POSIX inventory %j', async (stdout) => {
  vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
  execute.mockResolvedValue({ stdout });
  const { awaitRetirement } = await import('../src/daemon/process-retirement.js');
  await expect(awaitRetirement([root])).rejects.toThrow(/Invalid process observation/);
});
