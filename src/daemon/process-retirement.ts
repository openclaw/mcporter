import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveSystemPowerShellPath } from '../chrome-devtools-relay-handoff.js';
const exec = promisify(execFile);
export interface ProcessIdentity {
  pid: number;
  parent: number;
  owner: string;
  born: string;
}
interface ProcessObservation extends Omit<ProcessIdentity, 'owner' | 'born'> {
  owner: string | null;
  born: string | null;
}
interface Inventory {
  owner: string;
  processes: ProcessObservation[];
}
interface ObservationRequest {
  pids: readonly number[];
  tree: boolean;
  resolve(inventory: Inventory): void;
  reject(error: unknown): void;
}
const MAX_TARGETS = 256;
const MAX_TREE = 1024;
let pending: ObservationRequest[] = [];

export class ProcessObservationError extends Error {
  readonly code = 'process_observation_failed';
}

function observationFailure(detail: string): ProcessObservationError {
  return new ProcessObservationError(
    `Windows process observation ${detail}; retirement remains blocked. Check Windows process query access and retry.`
  );
}

const sid = (candidate: unknown) => typeof candidate === 'string' && /^S-\d+(?:-\d+)+$/.test(candidate);

function decodeWindowsInventory(stdout: string): Inventory {
  let value: Inventory & { version?: number };
  try {
    value = JSON.parse(stdout.replace(/^\uFEFF/, ''));
  } catch {
    throw observationFailure('returned invalid or empty JSON');
  }
  if (
    !value ||
    value.version !== 1 ||
    !sid(value.owner) ||
    !Array.isArray(value.processes) ||
    value.processes.length > MAX_TREE
  )
    throw observationFailure('returned an invalid completion envelope');
  const seen = new Set<number>();
  for (const item of value.processes) {
    if (
      !item ||
      !Number.isSafeInteger(item.pid) ||
      item.pid <= 0 ||
      seen.has(item.pid) ||
      !Number.isSafeInteger(item.parent) ||
      item.parent < 0 ||
      (item.owner !== null && !sid(item.owner)) ||
      (item.born !== null &&
        (typeof item.born !== 'string' ||
          !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{7}Z$/.test(item.born) ||
          !Number.isFinite(Date.parse(item.born))))
    )
      throw observationFailure('returned an invalid process identity');
    seen.add(item.pid);
  }
  return value;
}

async function windowsInventory(requests: readonly ObservationRequest[]): Promise<Inventory> {
  const roots = [...new Set(requests.filter((r) => r.tree).flatMap((r) => r.pids))];
  const targets = [...new Set(requests.flatMap((r) => r.pids))];
  const query =
    'SELECT Handle,ProcessId,ParentProcessId,CreationDate FROM Win32_Process' +
    (roots.length ? '' : ` WHERE ${targets.map((pid) => `ProcessId=${pid}`).join(' OR ')}`);
  // System.Management avoids CIM module startup. Only the selected tree needs owner queries.
  const script = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
Add-Type -AssemblyName System.Management
$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$searcher=New-Object System.Management.ManagementObjectSearcher('${query}')
$rows=@($searcher.Get())
$selected=@{}
foreach ($target in @(${targets.join(',')})) { $selected[[int]$target]=$true }
$frontier=@(${roots.join(',')})
$descendants=@{}
foreach ($root in $frontier) { $descendants[[int]$root]=$true }
while ($frontier.Count -gt 0) {
  $next=@()
  foreach ($item in $rows) {
    if ($frontier -contains [int]$item.ParentProcessId -and -not $descendants.ContainsKey([int]$item.ProcessId)) {
      $descendants[[int]$item.ProcessId]=$true
      $selected[[int]$item.ProcessId]=$true
      $next+=([int]$item.ProcessId)
      if ($selected.Count -gt ${MAX_TREE}) { throw 'tree limit' }
    }
  }
  $frontier=$next
}
$items=@(foreach ($item in $rows) {
  if (-not $selected.ContainsKey([int]$item.ProcessId)) { continue }
  $born=$null
  if ($null -ne $item.CreationDate) { $born=[System.Management.ManagementDateTimeConverter]::ToDateTime($item.CreationDate).ToUniversalTime().ToString('o') }
  $owner=$null
  try {
    $ownerArgs=[object[]]@('')
    if ($item.InvokeMethod('GetOwnerSid',$ownerArgs) -eq 0) { $owner=[string]$ownerArgs[0] }
  } catch { $owner=$null }
  @{pid=[int]$item.ProcessId;parent=[int]$item.ParentProcessId;owner=$owner;born=$born}
})
# Bind owner results to the same start identities; an exited process is definite absence.
$filter=($selected.Keys | ForEach-Object { 'ProcessId='+$_ }) -join ' OR '
$verify=New-Object System.Management.ManagementObjectSearcher("SELECT Handle,ProcessId,ParentProcessId,CreationDate FROM Win32_Process WHERE $filter")
$current=@{}
foreach ($item in $verify.Get()) { $current[[int]$item.ProcessId]=$item }
$checked=@(foreach ($item in $items) {
  $now=$current[$item.pid]
  if ($null -eq $now) { continue }
  $born=$null
  if ($null -ne $now.CreationDate) { $born=[System.Management.ManagementDateTimeConverter]::ToDateTime($now.CreationDate).ToUniversalTime().ToString('o') }
  if ($born -ne $item.born) { $item.owner=$null; $item.born=$null }
  $item
})
[Console]::Write((@{version=1;owner=$sid;processes=$checked}|ConvertTo-Json -Compress -Depth 4))
} catch { exit 1 }
`;
  let stdout: string;
  try {
    ({ stdout } = await exec(
      resolveSystemPowerShellPath(),
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }
    ));
  } catch {
    // execFile errors include the command and child output; neither is a safe diagnostic.
    throw observationFailure('failed');
  }
  return decodeWindowsInventory(stdout);
}

export async function processInventory(pids: readonly number[], tree = false): Promise<Inventory> {
  if (!pids.length || pids.length > MAX_TARGETS || pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 0))
    throw new Error('Invalid process observation targets.');
  if (process.platform === 'win32') {
    return new Promise((resolve, reject) => {
      pending.push({ pids: [...pids], tree, resolve, reject });
      if (pending.length !== 1) return;
      queueMicrotask(() => {
        // Do not join a query already in flight: it can predate a caller's process identity.
        const requests = pending;
        pending = [];
        let batch: ObservationRequest[] = [];
        let count = 0;
        const run = (group: ObservationRequest[]) => {
          void windowsInventory(group).then(
            (inventory) => {
              for (const request of group) request.resolve(inventory);
            },
            (error: unknown) => {
              for (const request of group) request.reject(error);
            }
          );
        };
        for (const request of requests) {
          if (count + request.pids.length > MAX_TARGETS) {
            run(batch);
            batch = [];
            count = 0;
          }
          batch.push(request);
          count += request.pids.length;
        }
        run(batch);
      });
    });
  }
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,uid=,lstart='], {
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const processes = stdout
    .trim()
    .split('\n')
    .map((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(.+)$/.exec(line);
      if (!match) throw new Error('Invalid process observation; retirement remains blocked.');
      return { pid: Number(match[1]), parent: Number(match[2]), owner: match[3]!, born: match[4]!.trim() };
    });
  return { owner: String(process.getuid?.()), processes };
}
export async function ownedProcessTree(pid: number): Promise<ProcessIdentity[]> {
  const inventory = await processInventory([pid], true);
  const root = inventory.processes.find((p) => p.pid === pid);
  if (!root || !root.born || root.owner !== inventory.owner)
    throw new Error('Legacy daemon process ownership could not be verified.');
  const result = [root as ProcessIdentity];
  for (let i = 0; i < result.length; i++)
    for (const p of inventory.processes)
      if (p.parent === result[i]!.pid && !result.some((item) => item.pid === p.pid)) {
        if (!p.born || p.owner !== inventory.owner) throw new Error('Legacy child ownership could not be verified.');
        result.push(p as ProcessIdentity);
      }
  return result;
}
export async function awaitRetirement(identities: readonly ProcessIdentity[]): Promise<void> {
  if (!identities.length) return;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    let alive = false;
    for (let offset = 0; offset < identities.length; offset += MAX_TARGETS) {
      const batch = identities.slice(offset, offset + MAX_TARGETS);
      const { processes } = await processInventory(batch.map((item) => item.pid));
      for (const old of batch) {
        const current = processes.find((item) => item.pid === old.pid);
        if (!current) continue;
        if (!current.born || !current.owner)
          throw new Error('Process ownership could not be verified; retirement remains blocked.');
        if (current.born === old.born.trim()) {
          if (current.owner !== old.owner)
            throw new Error('Process ownership could not be verified; retirement remains blocked.');
          alive = true;
        }
      }
    }
    if (!alive) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Verified legacy processes have not retired; cutover remains blocked. No process was signalled.');
}
