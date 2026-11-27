import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { processInventory } from './process-retirement.js';
import { daemonRunDir } from './paths.js';
import { isGeneration, type ManagedOwner } from './lifecycle-state.js';

const exec = promisify(execFile);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export interface ServiceReference {
  kind: 'systemd' | 'launchd';
  name: string;
  domain?: string;
}
export function serviceReference(generation: string, platform = process.platform): ServiceReference {
  if (!isGeneration(generation)) throw new Error('Invalid daemon generation.');
  const namespace = createHash('sha256').update(daemonRunDir()).digest('hex').slice(0, 16);
  if (platform === 'linux') return { kind: 'systemd', name: `mcporter-${namespace}-${generation}.service` };
  if (platform === 'darwin')
    return {
      kind: 'launchd',
      name: `com.mcporter.${namespace}.${generation}`,
      domain: `gui/${process.getuid?.() ?? 0}`,
    };
  throw new Error('Managed daemon requires systemd --user, launchd, or Windows Job Objects.');
}
export async function resolveServiceReference(generation: string): Promise<ServiceReference> {
  const ref = serviceReference(generation);
  if (ref.kind === 'launchd') {
    try {
      await exec('launchctl', ['print', ref.domain!], { timeout: 3000 });
    } catch {
      ref.domain = `user/${process.getuid?.() ?? 0}`;
      await exec('launchctl', ['print', ref.domain], { timeout: 3000 });
    }
  }
  return ref;
}
export const generationOutputPath = (generation: string) => path.join(daemonRunDir(), `output-${generation}.log`);
export const generationExitPath = (generation: string) => path.join(daemonRunDir(), `exit-${generation}.json`);
const plistPath = (generation: string) => path.join(daemonRunDir(), `service-${generation}.plist`);
const target = (ref: ServiceReference) => `${ref.domain}/${ref.name}`;
function verified(owner: ManagedOwner): ServiceReference {
  const expected = serviceReference(owner.generation);
  if (expected.kind === 'launchd' && owner.service?.domain === `user/${process.getuid?.() ?? 0}`)
    expected.domain = owner.service.domain;
  if (
    owner.service?.kind !== expected.kind ||
    owner.service.name !== expected.name ||
    owner.service.domain !== expected.domain
  )
    throw new Error('Unverified daemon service reference.');
  return expected;
}
function escapeXml(value: string): string {
  return value.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!
  );
}
export function launchdPlist(
  ref: ServiceReference,
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  output: string
): string {
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${escapeXml(ref.name)}</string><key>ProgramArguments</key><array>${[command, ...args].map((v) => `<string>${escapeXml(v)}</string>`).join('')}</array><key>EnvironmentVariables</key><dict>${Object.entries(
    env
  )
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `<key>${escapeXml(k)}</key><string>${escapeXml(v!)}</string>`)
    .join(
      ''
    )}</dict><key>WorkingDirectory</key><string>${escapeXml(daemonRunDir())}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>AbandonProcessGroup</key><false/><key>ExitTimeOut</key><integer>2</integer><key>StandardOutPath</key><string>${escapeXml(output)}</string><key>StandardErrorPath</key><string>${escapeXml(output)}</string></dict></plist>`;
}
export function serviceEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    'HOME',
    'USER',
    'LOGNAME',
    'PATH',
    'TMPDIR',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
    'MCPORTER_DAEMON_DIR',
    'MCPORTER_DAEMON_CHILD',
    'MCPORTER_DAEMON_WORKER',
    'MCPORTER_DAEMON_GENERATION',
    'MCPORTER_DAEMON_SOCKET',
    'MCPORTER_DAEMON_METADATA',
    'MCPORTER_DISABLE_AUTORUN',
  ];
  return Object.fromEntries(allowed.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])));
}
export async function verifyWorkerService(owner: ManagedOwner): Promise<void> {
  const ref = verified(owner);
  if (ref.kind === 'systemd') {
    const status = await systemdStatus(ref);
    const membership = await fs.readFile('/proc/self/cgroup', 'utf8');
    if (
      status.Description !== `mcporter-generation:${owner.generation}` ||
      Number(status.MainPID) !== process.pid ||
      !membership.split('\n').some((line) => line.endsWith('/' + ref.name))
    )
      throw new Error('Daemon is not the reserved systemd service.');
  } else if (process.env.XPC_SERVICE_NAME !== ref.name) throw new Error('Daemon is not the reserved launchd job.');
}
async function pruneGenerationFiles(current: string): Promise<void> {
  const entries = await fs.readdir(daemonRunDir());
  const generations = new Map<string, number>();
  for (const name of entries) {
    const match = /^(?:output|exit)-([a-f0-9-]{36})\.(?:log|json)$/.exec(name);
    if (match) {
      const info = await fs.stat(path.join(daemonRunDir(), name));
      generations.set(match[1]!, Math.max(generations.get(match[1]!) ?? 0, info.mtimeMs));
    }
  }
  const retained = new Set(
    [...generations.entries()]
      .toSorted((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([generation]) => generation)
  );
  retained.add(current);
  for (const name of entries) {
    const match = /^(?:output|exit)-([a-f0-9-]{36})\.(?:log|json)$/.exec(name);
    if (match && !retained.has(match[1]!)) await fs.unlink(path.join(daemonRunDir(), name));
  }
}
export async function startService(
  owner: ManagedOwner,
  command: string,
  args: string[],
  environment: NodeJS.ProcessEnv
): Promise<void> {
  const ref = verified(owner),
    env = { ...serviceEnvironment(environment), MCPORTER_DAEMON_DIR: path.dirname(daemonRunDir()) },
    output = generationOutputPath(owner.generation);
  await pruneGenerationFiles(owner.generation);
  await fs.writeFile(output, '', { flag: 'wx', mode: 0o600 });
  if (ref.kind === 'systemd') {
    try {
      await exec('systemctl', ['--user', 'show-environment'], { timeout: 5000 });
    } catch (error) {
      throw new Error(
        'Daemon mode requires a running systemd --user manager. Ordinary non-keep-alive calls remain available.',
        { cause: error }
      );
    }
    if ((await systemdStatus(ref)).LoadState !== 'not-found')
      throw new Error('Daemon service name already exists; refusing adoption.');
    await (await import('./lifecycle-state.js')).updateOwner(owner.generation, { serviceSubmitted: true });
    const version = Number(
      /systemd (\d+)/.exec((await exec('systemd-run', ['--version'], { timeout: 3000 })).stdout)?.[1]
    );
    const literal = (value: string) => (version >= 254 ? value : value.replace(/\$/g, () => '$$'));
    await exec(
      'systemd-run',
      [
        '--user',
        `--unit=${ref.name}`,
        '--service-type=exec',
        ...(version >= 254 ? ['--expand-environment=no'] : []),
        '--property=KillMode=control-group',
        '--property=Restart=no',
        `--property=Description=mcporter-generation:${owner.generation}`,
        '--property=TimeoutStopSec=2s',
        `--property=WorkingDirectory=${process.cwd().replace(/%/g, '%%')}`,
        `--property=StandardOutput=append:${output.replace(/%/g, '%%')}`,
        `--property=StandardError=append:${output.replace(/%/g, '%%')}`,
        ...Object.entries(env).map(([k, v]) => `--setenv=${k}=${v}`),
        '--',
        literal(command),
        ...args.map(literal),
      ],
      { timeout: 10000 }
    );
  } else {
    await exec('launchctl', ['print', ref.domain!], { timeout: 5000 });
    if (await launchdLoaded(ref)) throw new Error('Daemon service name already exists; refusing adoption.');
    await fs.writeFile(plistPath(owner.generation), launchdPlist(ref, command, args, env, output), {
      flag: 'wx',
      mode: 0o600,
    });
    await (await import('./lifecycle-state.js')).updateOwner(owner.generation, { serviceSubmitted: true });
    await exec('launchctl', ['bootstrap', ref.domain!, plistPath(owner.generation)], { timeout: 10000 });
  }
}
async function systemdStatus(ref: ServiceReference): Promise<Record<string, string>> {
  const { stdout } = await exec(
    'systemctl',
    [
      '--user',
      'show',
      ref.name,
      '--property=LoadState,ActiveState,SubState,MainPID,ExecMainStatus,ExecMainCode,ControlGroup,Description',
    ],
    { timeout: 5000 }
  ).catch((error: unknown) => {
    throw new Error('Cannot query systemd --user; daemon mode requires an available user manager.', { cause: error });
  });
  return Object.fromEntries(
    stdout
      .trim()
      .split('\n')
      .map((line) => {
        const at = line.indexOf('=');
        return [line.slice(0, at), line.slice(at + 1)];
      })
  );
}
async function launchdLoaded(ref: ServiceReference): Promise<boolean> {
  try {
    await exec('launchctl', ['print', target(ref)], { timeout: 3000 });
    return true;
  } catch (error) {
    const failure = error as { code?: number; stderr?: string };
    if (failure.code === 113 || failure.code === 3) return false;
    throw error;
  }
}
async function groupAlive(owner: ManagedOwner): Promise<boolean> {
  if (!owner.identity) return false;
  const current = (await processInventory([owner.identity.pid])).processes.find(
    (row) => row.pid === owner.identity!.pid
  );
  if (current && current.born !== owner.identity.born) return false;
  const { stdout } = await exec('ps', ['-axo', 'pgid=', '-o', 'stat='], { timeout: 3000, maxBuffer: 4 * 1024 * 1024 });
  const rows = stdout
    .trim()
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(\S+)/.exec(line));
  if (rows.some((row) => !row)) throw new Error('Invalid process group observation.');
  return rows.some((row) => Number(row![1]) === owner.identity!.pid && !row![2]!.startsWith('Z'));
}
export async function retireService(owner: ManagedOwner): Promise<void> {
  const ref = verified(owner);
  if (!owner.serviceSubmitted) return;
  let group: string | undefined;
  if (ref.kind === 'systemd') {
    const status = await systemdStatus(ref);
    group = status.ControlGroup;
    if (status.LoadState !== 'not-found') {
      if (status.Description !== `mcporter-generation:${owner.generation}`)
        throw new Error('Daemon unit ownership mismatch; no service stopped.');
      try {
        await exec('systemctl', ['--user', 'stop', ref.name], { timeout: 15000 });
      } catch (error) {
        // systemd may collect a stopped transient service between show and stop.
        if ((await systemdStatus(ref)).LoadState !== 'not-found') throw error;
      }
      // A failed transient unit must be released before a later namespace generation.
      await exec('systemctl', ['--user', 'reset-failed', ref.name], { timeout: 3000 }).catch(() => {});
    }
  } else if (await launchdLoaded(ref)) {
    const { stdout } = await exec('launchctl', ['print', target(ref)], { timeout: 3000 });
    const declared = /^\s*path = (.+)$/m.exec(stdout)?.[1]?.trim();
    if (!declared || (await fs.realpath(declared)) !== (await fs.realpath(plistPath(owner.generation))))
      throw new Error('Daemon launchd registration ownership is unverified; no job stopped.');
    await exec('launchctl', ['bootout', target(ref)], { timeout: 15000 });
  }
  if (ref.kind === 'launchd' && owner.identity) {
    if (!owner.darwinOwnership) throw new Error('Missing launchd coalition ownership; no saved PID was signalled.');
    await (await import('./darwin-native.js')).retireDarwinGroup(owner.identity.pid, owner.darwinOwnership);
  }
  const deadline = Date.now() + 10000;
  while (true) {
    let alive = false;
    if (ref.kind === 'systemd') {
      const status = await systemdStatus(ref);
      if (
        status.ActiveState === 'active' ||
        status.ActiveState === 'activating' ||
        status.ActiveState === 'deactivating'
      )
        alive = true;
      if (group && /^\/[\w./:@\\-]+$/.test(group)) {
        const events = await fs
          .readFile(path.join('/sys/fs/cgroup', group, 'cgroup.events'), 'utf8')
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error;
            return '';
          });
        alive ||= /^populated 1$/m.test(events);
      }
    } else alive = owner.darwinOwnership ? false : await groupAlive(owner);
    if (!alive) break;
    if (Date.now() >= deadline) throw new Error('Daemon service cleanup did not finish; replacement refused.');
    await delay(50);
  }
  const output = generationOutputPath(owner.generation);
  const log = await fs.stat(output).catch(() => undefined);
  if (log && log.size > 1024 * 1024) await fs.truncate(output, 1024 * 1024);
  if (ref.kind === 'launchd')
    await fs.unlink(plistPath(owner.generation)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
}
export async function waitForServiceExit(owner: ManagedOwner, foreground = false): Promise<number> {
  let offset = 0;
  const drain = async () => {
    if (!foreground) return;
    const file = await fs.open(generationOutputPath(owner.generation), 'r').catch(() => undefined);
    if (!file) return;
    try {
      const info = await file.stat();
      if (info.size < offset) offset = 0;
      if (info.size > offset) {
        const size = Math.min(info.size - offset, 64 * 1024);
        const buffer = Buffer.alloc(size);
        const { bytesRead } = await file.read(buffer, 0, size, offset);
        process.stdout.write(buffer.subarray(0, bytesRead));
        offset += bytesRead;
      }
    } finally {
      await file.close();
    }
  };
  while (true) {
    await drain();
    let running = false,
      code = 1;
    if (owner.service?.kind === 'systemd') {
      const status = await systemdStatus(verified(owner));
      running = ['active', 'activating', 'deactivating'].includes(status.ActiveState ?? '');
      code = status.LoadState === 'not-found' ? 1 : Number(status.ExecMainStatus) || 0;
      if (status.ExecMainCode === '2') code += 128;
    } else {
      // The authenticated worker publishes its identity; no safety decision depends on launchctl's display format.
      const { readLifecycle } = await import('./lifecycle-state.js');
      const latest = (await readLifecycle()).active;
      const identity = latest?.generation === owner.generation ? latest.identity : owner.identity;
      if (identity) {
        const row = (await processInventory([identity.pid])).processes.find((item) => item.pid === identity.pid);
        running = !!row && row.born === identity.born;
        if (!running) code = 1;
      } else running = await launchdLoaded(verified(owner));
    }
    if (!running) {
      await drain();
      const receipt = (await fs
        .readFile(generationExitPath(owner.generation), 'utf8')
        .then(JSON.parse)
        .catch(() => undefined)) as { generation?: string; code?: number } | undefined;
      const lifecycle = (await (await import('./lifecycle-state.js')).readLifecycle()).active;
      if (lifecycle?.generation === owner.generation && lifecycle.cleanExit) code = 0;
      return receipt?.generation === owner.generation && Number.isInteger(receipt.code) ? receipt.code! : code;
    }
    await delay(100);
  }
}
