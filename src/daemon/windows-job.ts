import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolveSystemPowerShellPath } from '../chrome-devtools-relay-handoff.js';
import { jobProofPath } from './lifecycle-state.js';
import { windowsJobScript } from './windows-job-script.js';

const exec = promisify(execFile);
function invocation(request: object): string[] {
  const encoded = Buffer.from(JSON.stringify(request)).toString('base64');
  const script = `${windowsJobScript}\nInvoke-McporterJob ('${encoded}' | ForEach-Object { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($_)) | ConvertFrom-Json })`;
  return [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ];
}
let guardian: ChildProcessWithoutNullStreams | undefined;
export function openManagedBrowser(url: string): boolean {
  if (!guardian || !guardian.stdin.writable) return false;
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  guardian.stdin.write(`${JSON.stringify({ open: url })}\n`);
  return true;
}
export async function attachWindowsJob(generation: string): Promise<string> {
  const name = `Global\\MCPorter-${generation}`;
  const challenge = randomUUID();
  const child = spawn(
    resolveSystemPowerShellPath(),
    invocation({ mode: 'attach', pid: process.pid, name, challenge, generation, proof: jobProofPath(generation) }),
    {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Windows daemon ownership setup timed out.')), 15_000);
      let pending = '';
      const fail = () => {
        clearTimeout(timer);
        reject(new Error('Windows daemon ownership setup failed.'));
      };
      child.on('error', fail);
      child.once('exit', fail);
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.stdout.on('data', (chunk: Buffer) => {
        pending += chunk.toString('utf8');
        if (pending.length > 4096) {
          fail();
          return;
        }
        let end: number;
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          try {
            const value = JSON.parse(line) as { challenge?: string; ready?: boolean };
            if (value.challenge === challenge) child.stdin.write(`${challenge}\n`);
            else if (value.ready === true) {
              clearTimeout(timer);
              child.off('exit', fail);
              resolve();
            } else fail();
          } catch {
            fail();
          }
        }
      });
    });
  } catch (error) {
    child.stdin.destroy();
    child.kill();
    throw error;
  }
  guardian = child;
  // Natural host exit must close the pipe only after its final RPC response drains.
  child.unref();
  for (const pipe of [child.stdin, child.stdout, child.stderr]) (pipe as { unref?: () => void }).unref?.();
  return name;
}
export async function inspectWindowsJob(name: string, terminate = false): Promise<number> {
  try {
    const { stdout } = await exec(
      resolveSystemPowerShellPath(),
      invocation({ mode: terminate ? 'terminate' : 'inspect', name }),
      {
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: 4096,
      }
    );
    const value = JSON.parse(stdout.replace(/^\uFEFF/, '').trim()) as { active?: number };
    if (!Number.isSafeInteger(value.active) || value.active! < 0) throw new Error('Invalid job observation.');
    return value.active!;
  } catch {
    throw new Error('Windows daemon job observation or retirement failed; no PID was signalled.');
  }
}
