import type { ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Logger } from './logging.js';

// closeTransportAndWait closes transports and ensures backing processes exit cleanly.
export async function closeTransportAndWait(
  logger: Logger,
  transport: Transport & { close(): Promise<void> }
): Promise<void> {
  const pidBeforeClose = getTransportPid(transport);
  const childProcess =
    transport instanceof StdioClientTransport
      ? ((transport as unknown as { _process?: ChildProcess | null })._process ?? null)
      : null;
  try {
    await transport.close();
  } catch (error) {
    logger.warn(`Failed to close transport cleanly: ${(error as Error).message}`);
  }

  if (childProcess) {
    await waitForChildClose(childProcess, 1_000).catch(() => {});
  }

  if (!pidBeforeClose) {
    return;
  }

  await ensureProcessTerminated(logger, pidBeforeClose);
}

function getTransportPid(transport: Transport & { pid?: number | null }): number | null {
  if (transport instanceof StdioClientTransport) {
    const pid = transport.pid;
    return typeof pid === 'number' && pid > 0 ? pid : null;
  }
  if ('pid' in transport) {
    const candidate = transport.pid;
    if (typeof candidate === 'number' && candidate > 0) {
      return candidate;
    }
  }
  const rawPid = (transport as unknown as { _process?: { pid?: number } | null | undefined })._process?.pid;
  return typeof rawPid === 'number' && rawPid > 0 ? rawPid : null;
}

async function ensureProcessTerminated(logger: Logger, pid: number): Promise<void> {
  await ensureProcessTreeTerminated(logger, pid);
}

async function waitForChildClose(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (
    (child as { exitCode?: number | null }).exitCode !== null &&
    (child as { exitCode?: number | null }).exitCode !== undefined
  ) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };
    const timeout = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(new Error(`Timed out waiting ${timeoutMs}ms for child process to close.`));
    };
    const cleanup = () => {
      child.removeListener('close', finish);
      child.removeListener('exit', finish);
      child.removeListener('error', finish);
      if (timer) {
        clearTimeout(timer);
      }
    };
    child.once('close', finish);
    child.once('exit', finish);
    child.once('error', finish);
    let timer: NodeJS.Timeout | undefined;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(timeout, timeoutMs);
      timer.unref?.();
    }
  });

  try {
    child.stdin?.end?.();
  } catch {
    // ignore
  }
  try {
    child.stdout?.destroy?.();
    child.stdout?.removeAllListeners?.();
    (child.stdout as unknown as { unref?: () => void })?.unref?.();
  } catch {
    // ignore
  }
  try {
    child.stderr?.destroy?.();
    child.stderr?.removeAllListeners?.();
    (child.stderr as unknown as { unref?: () => void })?.unref?.();
  } catch {
    // ignore
  }
  try {
    const stdio = (child as { stdio?: unknown[] }).stdio;
    if (Array.isArray(stdio)) {
      for (const stream of stdio) {
        if (!stream || typeof stream !== 'object') {
          continue;
        }
        try {
          (stream as { removeAllListeners?: () => void }).removeAllListeners?.();
          (stream as { destroy?: () => void }).destroy?.();
          (stream as { end?: () => void }).end?.();
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // ignore
  }
  try {
    child.removeAllListeners();
  } catch {
    // ignore
  }
  try {
    child.unref?.();
  } catch {
    // ignore
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function ensureProcessTreeTerminated(logger: Logger, rootPid: number): Promise<void> {
  if (!isProcessAlive(rootPid)) {
    return;
  }

  let targets = await collectProcessTreePids(rootPid);
  if (await waitForTreeExit(targets, 300)) {
    return;
  }

  await sendSignalToTargets(targets, 'SIGTERM');
  targets = await collectProcessTreePids(rootPid);
  if (await waitForTreeExit(targets, 700)) {
    return;
  }

  targets = await collectProcessTreePids(rootPid);
  await sendSignalToTargets(targets, 'SIGKILL');
  if (await waitForTreeExit(targets, 500)) {
    return;
  }

  logger.warn(`Process tree rooted at pid=${rootPid} did not exit after SIGKILL.`);
}

async function sendSignalToTargets(pids: number[], signal: NodeJS.Signals): Promise<void> {
  const seen = new Set<number>();
  for (const pid of pids) {
    if (seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    sendSignal(pid, signal);
  }
}

function sendSignal(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (typeof error === 'object' && error && 'code' in error && (error as { code?: string }).code === 'ESRCH') {
      return;
    }
    throw error;
  }
}

async function listDescendantPids(rootPid: number): Promise<number[]> {
  if (!isProcessAlive(rootPid)) {
    return [];
  }
  if (process.platform === 'win32') {
    return listDescendantPidsWindows(rootPid);
  }

  try {
    const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=']);
    const children = new Map<number, number[]>();
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const [pidText, ppidText] = trimmed.split(/\s+/, 2);
      const pid = Number.parseInt(pidText ?? '', 10);
      const ppid = Number.parseInt(ppidText ?? '', 10);
      if (!Number.isFinite(pid) || !Number.isFinite(ppid)) {
        continue;
      }
      const bucket = children.get(ppid) ?? [];
      bucket.push(pid);
      children.set(ppid, bucket);
    }

    return collectDescendantsFromChildren(rootPid, children);
  } catch {
    return [];
  }
}

async function listDescendantPidsWindows(rootPid: number): Promise<number[]> {
  try {
    const powershellScript =
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress';
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-Command', powershellScript]);
    const trimmed = stdout.trim();
    if (!trimmed) {
      return [];
    }
    const parsed = JSON.parse(trimmed) as
      | { ProcessId?: number; ParentProcessId?: number }
      | Array<{ ProcessId?: number; ParentProcessId?: number }>;
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    const children = new Map<number, number[]>();
    for (const entry of entries) {
      const pidCandidate = entry?.ProcessId;
      const ppidCandidate = entry?.ParentProcessId;
      if (typeof pidCandidate !== 'number' || typeof ppidCandidate !== 'number') {
        continue;
      }
      const pid = Number.isFinite(pidCandidate) ? pidCandidate : undefined;
      const ppid = Number.isFinite(ppidCandidate) ? ppidCandidate : undefined;
      if (pid === undefined || ppid === undefined) {
        continue;
      }
      const bucket = children.get(ppid) ?? [];
      bucket.push(pid);
      children.set(ppid, bucket);
    }
    return collectDescendantsFromChildren(rootPid, children);
  } catch {
    return [];
  }
}

function execFileAsync(command: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function collectProcessTreePids(rootPid: number): Promise<number[]> {
  const descendants = await listDescendantPids(rootPid);
  return [...descendants, rootPid];
}

function collectDescendantsFromChildren(rootPid: number, children: Map<number, number[]>): number[] {
  const result: number[] = [];
  const queue = [...(children.get(rootPid) ?? [])];
  const seen = new Set<number>(queue);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) {
      continue;
    }
    result.push(current);
    for (const child of children.get(current) ?? []) {
      if (!seen.has(child)) {
        seen.add(child);
        queue.push(child);
      }
    }
  }
  return result;
}

export const __testHooks = {
  listDescendantPids,
  waitForChildClose,
};

async function waitForTreeExit(pids: number[], durationMs: number): Promise<boolean> {
  const deadline = Date.now() + durationMs;
  while (true) {
    if (pids.every((pid) => !isProcessAlive(pid))) {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    const remaining = Math.max(10, Math.min(100, deadline - Date.now()));
    await delay(remaining);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof (timer as { unref?: () => void }).unref === 'function') {
      (timer as { unref?: () => void }).unref?.();
    }
  });
}
