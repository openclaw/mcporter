import koffi from 'koffi';
import type { ProcessIdentity } from './process-retirement.js';
type Handle = bigint | null;
const k = koffi.load('kernel32.dll'),
  a = koffi.load('advapi32.dll');
const api = {
  CloseHandle: k.func('int CloseHandle(void *handle)'),
  GetLastError: k.func('uint32 GetLastError()'),
  GetCurrentProcess: k.func('void *GetCurrentProcess()'),
  OpenProcess: k.func('void *OpenProcess(uint32 access, int inherit, uint32 pid)'),
  WaitForSingleObject: k.func('uint32 WaitForSingleObject(void *handle, uint32 timeout)'),
  GetProcessTimes: k.func('int GetProcessTimes(void *process, void *created, void *exit, void *kernel, void *user)'),
  GetProcessHandleCount: k.func('int GetProcessHandleCount(void *process, _Out_ uint32 *count)'),
  CreateToolhelp32Snapshot: k.func('void *CreateToolhelp32Snapshot(uint32 flags, uint32 pid)'),
  CreateJobObjectW: k.func('void *CreateJobObjectW(void *attributes, str16 name)'),
  OpenJobObjectW: k.func('void *OpenJobObjectW(uint32 access, int inherit, str16 name)'),
  SetInformationJobObject: k.func('int SetInformationJobObject(void *job, int type, void *info, uint32 size)'),
  AssignProcessToJobObject: k.func('int AssignProcessToJobObject(void *job, void *process)'),
  QueryInformationJobObject: k.func(
    'int QueryInformationJobObject(void *job, int type, void *info, uint32 size, _Out_ uint32 *written)'
  ),
  TerminateJobObject: k.func('int TerminateJobObject(void *job, uint32 code)'),
  TerminateProcess: k.func('int TerminateProcess(void *process, uint32 code)'),
  IsProcessInJob: k.func('int IsProcessInJob(void *process, void *job, _Out_ int *result)'),
  LocalFree: k.func('void *LocalFree(void *ptr)'),
  OpenProcessToken: a.func('int OpenProcessToken(void *process, uint32 access, _Out_ void **token)'),
  GetTokenInformation: a.func(
    'int GetTokenInformation(void *token, int type, void *buffer, uint32 size, _Out_ uint32 *required)'
  ),
  ConvertSidToStringSidW: a.func('int ConvertSidToStringSidW(void *sid, _Out_ void **text)'),
  ConvertStringSecurityDescriptor: a.func(
    'int ConvertStringSecurityDescriptorToSecurityDescriptorW(str16 text,uint32 revision,_Out_ void **descriptor,_Out_ uint32 *size)'
  ),
};
const Entry = koffi.struct('ProbeProcessEntry', {
  size: 'uint32',
  usage: 'uint32',
  pid: 'uint32',
  heap: 'uintptr_t',
  module: 'uint32',
  threads: 'uint32',
  parent: 'uint32',
  priority: 'int32',
  flags: 'uint32',
  name: koffi.array('uint16', 260),
});
const processFirst = k.func('int Process32FirstW(void *snapshot, _Inout_ ProbeProcessEntry *entry)');
const processNext = k.func('int Process32NextW(void *snapshot, _Inout_ ProbeProcessEntry *entry)');
function fail(operation: string, code: number = api.GetLastError()): never {
  const error = new Error(`${operation}: Win32 ${code}`);
  Object.assign(error, { win32: code });
  throw error;
}
function check<T>(value: T, operation: string): NonNullable<T> {
  if (!value) fail(operation);
  return value as NonNullable<T>;
}
function close(handle: Handle | undefined) {
  if (handle !== null && handle !== 0n) check(api.CloseHandle(handle), 'CloseHandle');
}
function open(pid: number, access = 0x101000): Handle {
  const handle = api.OpenProcess(access, 0, pid);
  if (!handle) {
    const error = api.GetLastError();
    if (error === 87) return null;
    fail('OpenProcess', error);
  }
  return handle;
}
function owner(handle: Handle): string {
  const token: Handle[] = [null];
  check(api.OpenProcessToken(handle, 8, token), 'OpenProcessToken');
  try {
    const needed = [0];
    api.GetTokenInformation(token[0], 1, null, 0, needed);
    if (needed[0] === 0) fail('GetTokenInformation.size');
    const buffer = Buffer.alloc(needed[0]!);
    check(api.GetTokenInformation(token[0], 1, buffer, buffer.length, needed), 'GetTokenInformation');
    const sid = koffi.decode(buffer, 'void *');
    const text: Handle[] = [null];
    check(api.ConvertSidToStringSidW(sid, text), 'ConvertSidToStringSidW');
    try {
      return koffi.decode.string16(text[0]) as string;
    } finally {
      api.LocalFree(text[0]);
    }
  } finally {
    close(token[0]);
  }
}
export function windowsBirthTime(ticks: bigint): string {
  const unix = ticks - 116444736000000000n;
  const ms = unix / 10000n;
  return new Date(Number(ms)).toISOString().slice(0, -1) + ((unix % 10000n) / 10n).toString().padStart(3, '0') + '0Z';
}
function snapshot(): Map<number, number> {
  const handle = api.CreateToolhelp32Snapshot(2, 0);
  if (handle === -1n || handle === 0xffffffffffffffffn) fail('Snapshot');
  try {
    const entry = { size: koffi.sizeof(Entry), pid: 0, parent: 0 };
    const result = new Map<number, number>();
    let more = processFirst(handle, entry);
    while (more) {
      result.set(entry.pid, entry.parent);
      more = processNext(handle, entry);
    }
    const error = api.GetLastError();
    if (error !== 18) fail('Process32Next', error);
    return result;
  } finally {
    close(handle);
  }
}
function state(handle: Handle) {
  const value = api.WaitForSingleObject(handle, 0);
  if (value !== 0 && value !== 258) fail('WaitForSingleObject');
  return value;
}
export async function observeWindowsProcesses(
  targets: readonly number[],
  roots: readonly number[] = []
): Promise<{ version: number; owner: string; processes: ProcessIdentity[] }> {
  if (!targets.length || targets.length > 256 || targets.some((pid) => !Number.isSafeInteger(pid) || pid <= 0))
    throw new Error('Invalid targets');
  const held = new Map<number, { pid: number; handle: Handle; ticks: bigint; owner: string; born: string }>();
  function pin(pid: number) {
    const h = open(pid);
    if (!h) return;
    let keep = false;
    try {
      if (state(h) === 0) return;
      const times = Buffer.alloc(32);
      check(
        api.GetProcessTimes(h, times.subarray(0, 8), times.subarray(8, 16), times.subarray(16, 24), times.subarray(24)),
        'GetProcessTimes'
      );
      const ticks = times.readBigUInt64LE();
      held.set(pid, { pid, handle: h, ticks, owner: owner(h), born: windowsBirthTime(ticks) });
      keep = true;
    } finally {
      if (!keep) close(h);
    }
  }
  try {
    for (const pid of new Set(targets)) pin(pid);
    const first = snapshot(),
      selected = new Set(targets),
      visited = new Set(roots),
      queue = [...roots];
    for (let i = 0; i < queue.length; i++)
      for (const [pid, parent] of first)
        if (parent === queue[i] && !visited.has(pid)) {
          visited.add(pid);
          selected.add(pid);
          queue.push(pid);
          if (selected.size > 1024) throw new Error('Tree limit');
        }
    for (const pid of selected) if (!held.has(pid) && !targets.includes(pid)) pin(pid);
    const second = snapshot(),
      processes = [];
    for (const row of held.values()) {
      if (state(row.handle) === 0 || !second.has(row.pid)) continue;
      const parent = first.get(row.pid);
      if (parent === undefined || second.get(row.pid) !== parent) throw new Error('Snapshot identity changed');
      // A stale PPID can name a younger process after PID reuse; that edge proves no ownership.
      const verifiedParent = held.has(parent) && held.get(parent)!.ticks > row.ticks ? 0 : parent;
      processes.push({ pid: row.pid, parent: verifiedParent, owner: row.owner, born: row.born });
    }
    return { version: 1, owner: owner(api.GetCurrentProcess()), processes };
  } finally {
    for (const row of held.values()) close(row.handle);
  }
}

export function createWindowsJob(name: string): Handle {
  const descriptor: Handle[] = [null],
    size = [0];
  check(
    api.ConvertStringSecurityDescriptor(`D:P(A;;GA;;;${owner(api.GetCurrentProcess())})`, 1, descriptor, size),
    'Job security descriptor'
  );
  const attributes = Buffer.alloc(24);
  attributes.writeUInt32LE(24, 0);
  attributes.writeBigUInt64LE(descriptor[0]!, 8);
  let job: Handle = null;
  try {
    job = check(api.CreateJobObjectW(attributes, name), 'CreateJobObject') as Handle;
    if (api.GetLastError() === 183) throw new Error('Daemon Job already exists; refusing adoption.');
  } catch (error) {
    close(job);
    throw error;
  } finally {
    api.LocalFree(descriptor[0]);
  }
  try {
    const limits = Buffer.alloc(144);
    limits.writeUInt32LE(0x2000, 16);
    check(api.SetInformationJobObject(job, 9, limits, limits.length), 'SetInformationJobObject');
    check(api.AssignProcessToJobObject(job, api.GetCurrentProcess()), 'AssignProcessToJobObject');
    return job;
  } catch (error) {
    close(job);
    throw error;
  }
}
export function inspectNativeWindowsJob(name: string, terminate = false): number {
  const job = api.OpenJobObjectW(terminate ? 12 : 4, 0, name) as Handle;
  if (!job) {
    const error = api.GetLastError();
    if (error === 2) return 0;
    fail('OpenJobObject', error);
  }
  try {
    if (terminate) check(api.TerminateJobObject(job, 1), 'TerminateJobObject');
    const accounting = Buffer.alloc(48),
      written = [0];
    check(api.QueryInformationJobObject(job, 1, accounting, accounting.length, written), 'QueryInformationJobObject');
    return accounting.readUInt32LE(40);
  } finally {
    close(job);
  }
}
