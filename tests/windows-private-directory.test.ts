import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ensureWindowsPrivateDirectory, resolveSystemPowerShellPath } from '../src/chrome-devtools-relay-handoff.js';

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

afterEach(() => vi.restoreAllMocks());

it.runIf(process.platform === 'win32')(
  'verifies private directories without audit privilege and still rejects broad ACLs',
  async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const prefix = await fs.readFile(
      new URL('./fixtures/windows-remove-security-privilege.ps1', import.meta.url),
      'utf8'
    );
    let auditRead = false;
    vi.mocked(spawnSync).mockImplementation((command, args, options) => {
      const parameters = [...(args ?? [])];
      let script = String(parameters.at(-1));
      if (auditRead) {
        script = script.replace(
          /\$check = .*GetAccessControl.*\n/,
          '$check = $directory.GetAccessControl([System.Security.AccessControl.AccessControlSections]::All)\n'
        );
      }
      parameters[parameters.length - 1] = `${prefix}\n${script}`;
      return actual.spawnSync(command, parameters, options);
    });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-no-audit-'));
    const directory = path.join(root, 'private');
    try {
      ensureWindowsPrivateDirectory(directory);
      ensureWindowsPrivateDirectory(directory, true);
      auditRead = true;
      expect(() => ensureWindowsPrivateDirectory(directory, true)).toThrow('stage=acl-read');
      auditRead = false;
      const changed = actual.spawnSync(
        resolveSystemPowerShellPath(),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          String.raw`
$ErrorActionPreference = 'Stop'
$directory = New-Object System.IO.DirectoryInfo -ArgumentList @($env:MCPORTER_TEST_ACL_DIRECTORY)
$acl = $directory.GetAccessControl([System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner)
$everyone = New-Object System.Security.Principal.SecurityIdentifier('S-1-1-0')
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($everyone, 'Read', 'Allow')
$acl.AddAccessRule($rule)
$directory.SetAccessControl($acl)
`,
        ],
        { encoding: 'utf8', env: { ...process.env, MCPORTER_TEST_ACL_DIRECTORY: directory } }
      );
      expect(changed.status, changed.stderr).toBe(0);
      expect(() => ensureWindowsPrivateDirectory(directory, true)).toThrow('stage=acl-verify');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  },
  60_000
);
