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

export async function processInventory(): Promise<{ owner: string; processes: ProcessIdentity[] }> {
  if (process.platform === 'win32') {
    const script = String.raw`$ErrorActionPreference='Stop'; $sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; $items=@(Get-CimInstance Win32_Process | Where-Object { $null -ne $_.CreationDate } | ForEach-Object { $p=$_; $owner=(Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid -ErrorAction SilentlyContinue).Sid; @{pid=[int]$p.ProcessId;parent=[int]$p.ParentProcessId;owner=$owner;born=$p.CreationDate.ToUniversalTime().ToString('o')} }); @{owner=$sid;processes=$items}|ConvertTo-Json -Compress -Depth 4`;
    const { stdout } = await exec(
      resolveSystemPowerShellPath(),
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 5000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }
    );
    return JSON.parse(stdout) as { owner: string; processes: ProcessIdentity[] };
  }
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,ppid=,uid=,lstart='], {
    timeout: 5000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const processes = stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), owner: match[3]!, born: match[4]! }] : [];
  });
  return { owner: String(process.getuid?.()), processes };
}
export async function ownedProcessTree(pid: number): Promise<ProcessIdentity[]> {
  const inventory = await processInventory();
  const root = inventory.processes.find((p) => p.pid === pid);
  if (!root || root.owner !== inventory.owner)
    throw new Error('Legacy daemon process ownership could not be verified.');
  const result = [root];
  for (let i = 0; i < result.length; i++)
    for (const p of inventory.processes)
      if (p.parent === result[i]!.pid && !result.some((item) => item.pid === p.pid)) {
        if (p.owner !== inventory.owner) throw new Error('Legacy child ownership could not be verified.');
        result.push(p);
      }
  return result;
}
export async function awaitRetirement(identities: readonly ProcessIdentity[]): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { processes } = await processInventory();
    if (
      identities.every(
        (old) =>
          !processes.some(
            (current) => current.pid === old.pid && current.owner === old.owner && current.born === old.born
          )
      )
    )
      return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('Verified legacy processes have not retired; cutover remains blocked. No process was signalled.');
}
