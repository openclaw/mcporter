import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { daemonRunDir } from './daemon/paths.js';
import { spawnSync } from 'node:child_process';
import { ensureWindowsPrivateDirectory, resolveSystemPowerShellPath } from './chrome-devtools-relay-handoff.js';
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex');
function verifyWindowsFile(file: string, claimOwnership = false): void {
  const script = String.raw`$ErrorActionPreference='Stop';$target=$env:MCPORTER_NATIVE_CACHE_FILE;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;if(([IO.File]::GetAttributes($target)-band[IO.FileAttributes]::ReparsePoint)-ne 0){exit 1};$acl=[IO.File]::GetAccessControl($target,[Security.AccessControl.AccessControlSections]::Access-bor[Security.AccessControl.AccessControlSections]::Owner);if($env:MCPORTER_NATIVE_CACHE_CLAIM-eq'1'){$acl.SetOwner([Security.Principal.SecurityIdentifier]::new($sid));[IO.File]::SetAccessControl($target,$acl)};if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value-ne$sid){exit 1};$rules=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));if($rules.Count-eq 0){exit 1};foreach($rule in $rules){if($rule.IdentityReference.Value-ne$sid-or$rule.AccessControlType-ne[Security.AccessControl.AccessControlType]::Allow){exit 1}}`;
  const result = spawnSync(
    resolveSystemPowerShellPath(),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      env: {
        ...process.env,
        MCPORTER_NATIVE_CACHE_FILE: file,
        MCPORTER_NATIVE_CACHE_CLAIM: claimOwnership ? '1' : '0',
      },
      stdio: 'ignore',
      windowsHide: true,
      timeout: 10000,
    }
  );
  if (result.status !== 0) throw new Error('Unsafe native addon file permissions.');
}
/** Bundled native modules use immutable content addresses: upgrades never replace a loaded DLL. */
export function loadEmbeddedNativeAddon(base64: string, digest: string): unknown {
  const bytes = Buffer.from(base64, 'base64');
  if (!/^[a-f0-9]{64}$/.test(digest) || hash(bytes) !== digest) throw new Error('Invalid embedded native addon.');
  const directory = path.join(daemonRunDir(), 'native');
  {
    const parent = path.dirname(directory);
    if (process.platform === 'win32') ensureWindowsPrivateDirectory(parent, true);
    else {
      fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
      const info = fs.lstatSync(parent);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o777) !== 0o700
      )
        throw new Error('Unsafe native addon cache parent.');
    }
    if (process.platform === 'win32') ensureWindowsPrivateDirectory(directory, true);
    else {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const info = fs.lstatSync(directory);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        info.uid !== process.getuid?.() ||
        (info.mode & 0o777) !== 0o700
      )
        throw new Error('Unsafe native addon cache.');
    }
  }
  const file = path.join(directory, `${process.arch}-${digest}.node`);
  const verify = () => {
    const info = fs.lstatSync(file);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1 ||
      (process.platform !== 'win32' && (info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0)) ||
      hash(fs.readFileSync(file)) !== digest
    )
      throw new Error('Native addon cache is unsafe or corrupt.');
  };
  try {
    verify();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const temporary = path.join(directory, `${digest}-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
      // Elevated Windows tokens otherwise give new files the Administrators owner.
      if (process.platform === 'win32') verifyWindowsFile(temporary, true);
      try {
        fs.renameSync(temporary, file);
      } catch (linkError) {
        if (
          (linkError as NodeJS.ErrnoException).code !== 'EEXIST' &&
          (linkError as NodeJS.ErrnoException).code !== 'EPERM'
        )
          throw linkError;
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
    verify();
  }
  if (process.platform === 'win32') verifyWindowsFile(file);
  const native = { exports: {} };
  process.dlopen(native, file);
  return native.exports;
}
