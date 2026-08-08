import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CHROME_RELAY_HANDOFF_ENV = 'MCPORTER_CHROME_RELAY_HANDOFF_PATH';
const HANDOFF_DIR_PREFIX = 'mcporter-chrome-relay-';
const HANDOFF_FILENAME = 'headers.json';
const PRELOAD_FILENAME = 'preload.mjs';
const WINDOWS_ACL_PATH_ENV = 'MCPORTER_CHROME_RELAY_ACL_PATH';

export interface ChromeDevtoolsRelayHandoff {
  readonly env: Record<string, string>;
  readonly handoffPath: string;
  readonly preloadPath: string;
  close(): Promise<void>;
}

export function createChromeDevtoolsRelayHandoff(
  env: Record<string, string>,
  clientAuthorization: string
): ChromeDevtoolsRelayHandoff {
  let directory: string | undefined;
  try {
    if (process.platform === 'win32') directory = createWindowsHandoffDirectory();
    else {
      directory = fs.mkdtempSync(path.join(os.tmpdir(), HANDOFF_DIR_PREFIX));
      fs.chmodSync(directory, 0o700);
    }
    assertSecurePath(directory, 'directory');

    const handoffPath = path.join(directory, HANDOFF_FILENAME);
    const preloadPath = path.join(directory, PRELOAD_FILENAME);
    writeExclusiveFile(preloadPath, renderChromeDevtoolsRelayPreloadSource());
    writeExclusiveFile(handoffPath, JSON.stringify({ Authorization: clientAuthorization }));

    const importFlag = `--import=${pathToFileURL(preloadPath).href}`;
    const existingOptions = env.NODE_OPTIONS?.trim();
    let closed = false;
    return {
      env: {
        ...env,
        NODE_OPTIONS: existingOptions ? `${existingOptions} ${importFlag}` : importFlag,
        [CHROME_RELAY_HANDOFF_ENV]: handoffPath,
      },
      handoffPath,
      preloadPath,
      async close() {
        if (closed) return;
        closed = true;
        cleanupHandoff(directory!, handoffPath, preloadPath);
      },
    };
  } catch {
    if (directory)
      cleanupHandoff(directory, path.join(directory, HANDOFF_FILENAME), path.join(directory, PRELOAD_FILENAME));
    throw new Error('Unable to install secure Chrome relay authorization handoff.');
  }
}

function createWindowsHandoffDirectory(): string {
  const directory = path.join(os.tmpdir(), `${HANDOFF_DIR_PREFIX}${randomBytes(16).toString('hex')}`);
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:${WINDOWS_ACL_PATH_ENV}
if ([System.IO.Directory]::Exists($target)) { throw 'handoff path already exists' }
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$security = New-Object System.Security.AccessControl.DirectorySecurity
$sidValue = $sid.Value
$security.SetSecurityDescriptorSddlForm("O:$($sidValue)G:$($sidValue)D:P(A;OICI;FA;;;$($sidValue))")
$directory = New-Object System.IO.DirectoryInfo -ArgumentList @($target)
$directory.Create($security)
$check = Get-Acl -LiteralPath $target
$rules = @($check.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
$ownerSid = $check.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
if (-not $check.AreAccessRulesProtected -or $ownerSid -ne $sid.Value -or $rules.Count -ne 1) { throw 'unsafe ACL' }
$ruleSid = $rules[0].IdentityReference.Value
$hasFullControl = ($rules[0].FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl
if ($ruleSid -ne $sid.Value -or $rules[0].IsInherited -or -not $hasFullControl -or $rules[0].AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { throw 'unsafe ACL' }
`;
  const result = spawnSync(
    resolveSystemPowerShellPath(),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      env: { ...process.env, [WINDOWS_ACL_PATH_ENV]: directory },
      stdio: 'ignore',
      windowsHide: true,
    }
  );
  if (result.status !== 0) {
    try {
      fs.rmdirSync(directory);
    } catch {}
    throw new Error('unsafe Windows ACL');
  }
  return directory;
}

function resolveSystemPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot?.trim() || process.env.WINDIR?.trim();
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw new Error('unsafe Windows system root');
  const executable = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const stat = fs.lstatSync(executable);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('unsafe Windows PowerShell path');
  return executable;
}

function writeExclusiveFile(filePath: string, contents: string): void {
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0),
    0o600
  );
  try {
    if (process.platform !== 'win32') fs.fchmodSync(descriptor, 0o600);
    fs.writeFileSync(descriptor, contents, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
  assertSecurePath(filePath, 'file');
}

function assertSecurePath(filePath: string, kind: 'directory' | 'file'): void {
  const stat = fs.lstatSync(filePath);
  if ((kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) || stat.isSymbolicLink()) throw new Error('unsafe');
  if (process.platform === 'win32') return;
  if ((stat.mode & 0o077) !== 0) throw new Error('unsafe');
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('unsafe');
}

function cleanupHandoff(directory: string, handoffPath: string, preloadPath: string): void {
  for (const filePath of [handoffPath, preloadPath]) {
    try {
      fs.unlinkSync(filePath);
    } catch {}
  }
  try {
    fs.rmdirSync(directory);
  } catch {}
}

export function renderChromeDevtoolsRelayPreloadSource(): string {
  return `import fs from 'node:fs';
import path from 'node:path';

const installChromeDevtoolsRelayHeaders = ${installChromeDevtoolsRelayHeaders.toString()};

installChromeDevtoolsRelayHeaders(fs, path, ${JSON.stringify(CHROME_RELAY_HANDOFF_ENV)});
`;
}

interface PreloadFileSystem {
  readonly constants: typeof fs.constants;
  closeSync(descriptor: number): void;
  fstatSync(descriptor: number): fs.Stats;
  ftruncateSync(descriptor: number, length?: number): void;
  lstatSync(filePath: string): fs.Stats;
  openSync(filePath: string, flags: number): number;
  readFileSync(descriptor: number, encoding: 'utf8'): string;
  unlinkSync(filePath: string): void;
}

interface PreloadPath {
  dirname(filePath: string): string;
  isAbsolute(filePath: string): boolean;
}

function installChromeDevtoolsRelayHeaders(fsApi: PreloadFileSystem, pathApi: PreloadPath, envName: string): void {
  const targetPath = process.argv[1]?.replaceAll('\\', '/').toLowerCase();
  if (!targetPath?.includes('chrome-devtools-mcp')) return;

  const failureMessage = 'MCPorter Chrome relay authorization handoff unavailable.';
  const fail = (): never => {
    throw new Error(failureMessage);
  };
  const handoffPath = process.env[envName];
  delete process.env[envName];
  if (!handoffPath || !pathApi.isAbsolute(handoffPath)) return fail();

  const directoryStat = (() => {
    try {
      return fsApi.lstatSync(pathApi.dirname(handoffPath));
    } catch {
      return fail();
    }
  })();
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) fail();
  if (process.platform !== 'win32') {
    if ((directoryStat.mode & 0o077) !== 0) fail();
    if (typeof process.getuid === 'function' && directoryStat.uid !== process.getuid()) fail();
  }

  const descriptor = (() => {
    try {
      return fsApi.openSync(handoffPath, fsApi.constants.O_RDONLY | (fsApi.constants.O_NOFOLLOW ?? 0));
    } catch {
      return fail();
    }
  })();

  let raw = '';
  let consumed = false;
  try {
    const stat = fsApi.fstatSync(descriptor);
    if (!stat.isFile() || stat.size <= 0 || stat.size > 4_096) fail();
    if (process.platform !== 'win32') {
      if ((stat.mode & 0o077) !== 0) fail();
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) fail();
    }
    raw = fsApi.readFileSync(descriptor, 'utf8');
    try {
      fsApi.unlinkSync(handoffPath);
      consumed = true;
    } catch {
      try {
        fsApi.ftruncateSync(descriptor, 0);
        consumed = true;
      } catch {
        fail();
      }
    }
  } finally {
    fsApi.closeSync(descriptor);
  }
  if (!consumed) fail();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail();
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length !== 1 || entries[0]?.[0] !== 'Authorization') fail();
  const authorization = entries[0]?.[1];
  if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{43}$/u.test(authorization)) fail();

  const terminatorIndex = process.argv.indexOf('--', 2);
  const insertionIndex = terminatorIndex >= 0 ? terminatorIndex : process.argv.length;
  process.argv.splice(insertionIndex, 0, '--wsHeaders', JSON.stringify({ Authorization: authorization }));
}
