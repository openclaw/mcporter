import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CHROME_RELAY_HANDOFF_ENV,
  createChromeDevtoolsRelayHandoff,
  type ChromeDevtoolsRelayHandoff,
} from '../src/chrome-devtools-relay-handoff.js';

const TARGET = fileURLToPath(new URL('./fixtures/chrome-devtools-mcp-handoff-target.mjs', import.meta.url));
const LAUNCHER = fileURLToPath(new URL('./fixtures/chrome-relay-handoff-launcher.mjs', import.meta.url));
const SOURCE_RENDERER = fileURLToPath(new URL('./fixtures/render-chrome-devtools-relay-preload.ts', import.meta.url));
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');
const ENDPOINT = 'ws://127.0.0.1:45678/cdp';
const STABLE_RELAY_TOKEN = 'stable-relay-token-must-not-appear';

describe('chrome-devtools relay preload handoff', () => {
  it('executes the source-runtime emitted preload without free helpers and consumes authorization once', async () => {
    const rendered = await runNode([TSX_CLI, SOURCE_RENDERER], { ...process.env } as Record<string, string>);
    expect(rendered.code, rendered.stderr).toBe(0);

    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-rendered-handoff-'));
    const handoffPath = path.join(directory, 'headers.json');
    const preloadPath = path.join(directory, 'preload.mjs');
    const authorization = `Bearer ${'k'.repeat(43)}`;
    await fs.chmod(directory, 0o700);
    await fs.writeFile(preloadPath, rendered.stdout, { mode: 0o600 });
    await fs.writeFile(handoffPath, JSON.stringify({ Authorization: authorization }), { mode: 0o600 });
    const env = {
      ...process.env,
      NODE_OPTIONS: `--import=${pathToFileURL(preloadPath).href}`,
      [CHROME_RELAY_HANDOFF_ENV]: handoffPath,
    } as Record<string, string>;

    try {
      const first = await runNode([TARGET, ENDPOINT], env);
      expect(first.code, first.stderr).toBe(0);
      expect(rendered.stdout).not.toMatch(/\b__[A-Za-z_$][\w$]*\b/u);
      expect(JSON.parse(first.stdout)).toMatchObject({
        hasWsHeaders: true,
        authorizationDigest: createHash('sha256').update(authorization).digest('hex'),
        handoffEnvPresent: false,
      });
      await expect(fs.stat(handoffPath)).rejects.toMatchObject({ code: 'ENOENT' });

      const second = await runNode([TARGET, ENDPOINT], env);
      expect(second.code).not.toBe(0);
      expect(second.stderr).toContain('MCPorter Chrome relay authorization handoff unavailable.');
      expect(second.stderr).not.toContain(handoffPath);
      expect(second.stderr).not.toContain(authorization);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it('uses protected files, preserves NODE_OPTIONS, and mutates argv only inside the target child', async () => {
    const authorization = `Bearer ${'d'.repeat(43)}`;
    const handoff = createChromeDevtoolsRelayHandoff(
      { ...process.env, NODE_OPTIONS: '--trace-warnings' } as Record<string, string>,
      authorization
    );
    const directory = path.dirname(handoff.handoffPath);
    try {
      await expectProtectedPath(directory, 'directory', 0o700);
      await expectProtectedPath(handoff.handoffPath, 'file', 0o600);
      await expectProtectedPath(handoff.preloadPath, 'file', 0o600);
      expect(handoff.env.NODE_OPTIONS).toContain('--trace-warnings');
      expect(handoff.env.NODE_OPTIONS).toContain('--import=file://');
      expect(handoff.env[CHROME_RELAY_HANDOFF_ENV]).toBe(handoff.handoffPath);
      expect(handoff.env[CHROME_RELAY_HANDOFF_ENV]).not.toContain(authorization);

      const result = await runNode([LAUNCHER, TARGET, ENDPOINT, '--', 'positional'], handoff.env);
      expect(result.code).toBe(0);
      expect(result.spawnargs).toContain(ENDPOINT);
      expect(result.spawnargs.join('\0')).not.toContain(authorization);
      expect(result.spawnargs.join('\0')).not.toContain(STABLE_RELAY_TOKEN);
      expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({
        endpoint: ENDPOINT,
        hasWsHeaders: true,
        headersBeforeTerminator: true,
        authorizationDigest: createHash('sha256').update(authorization).digest('hex'),
        handoffEnvPresent: false,
      });
      await expect(fs.stat(handoff.handoffPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(handoff.preloadPath)).resolves.toBeDefined();
    } finally {
      await handoff.close();
    }
    await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails closed for missing, invalid, or consumed handoffs', async () => {
    await expectRejectedHandoff(async (handoff) => {
      await fs.unlink(handoff.handoffPath);
    });
    await expectRejectedHandoff(async (handoff) => {
      await fs.writeFile(handoff.handoffPath, '{}', 'utf8');
    });

    const authorization = `Bearer ${'e'.repeat(43)}`;
    const consumed = createChromeDevtoolsRelayHandoff({ ...process.env } as Record<string, string>, authorization);
    try {
      expect((await runNode([TARGET, ENDPOINT], consumed.env)).code).toBe(0);
      const second = await runNode([TARGET, ENDPOINT], consumed.env);
      expect(second.code).not.toBe(0);
      expect(second.stderr).toContain('MCPorter Chrome relay authorization handoff unavailable.');
      expect(second.stderr).not.toContain(consumed.handoffPath);
      expect(second.stderr).not.toContain(authorization);
    } finally {
      await consumed.close();
    }
  });

  it.runIf(process.platform !== 'win32')('rejects broad modes and symlink handoffs', async () => {
    await expectRejectedHandoff(async (handoff) => {
      await fs.chmod(handoff.handoffPath, 0o644);
    });
    await expectRejectedHandoff(async (handoff) => {
      await fs.chmod(path.dirname(handoff.handoffPath), 0o755);
    });
    const authorization = `Bearer ${'h'.repeat(43)}`;
    const handoff = createChromeDevtoolsRelayHandoff({ ...process.env } as Record<string, string>, authorization);
    const target = `${handoff.handoffPath}.target`;
    try {
      await fs.writeFile(target, JSON.stringify({ Authorization: `Bearer ${'f'.repeat(43)}` }), { mode: 0o600 });
      await fs.unlink(handoff.handoffPath);
      await fs.symlink(target, handoff.handoffPath);
      const result = await runNode([TARGET, ENDPOINT], handoff.env);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain('MCPorter Chrome relay authorization handoff unavailable.');
      expect(result.stderr).not.toContain(handoff.handoffPath);
      expect(result.stderr).not.toContain(authorization);
    } finally {
      await fs.unlink(target).catch(() => {});
      await handoff.close();
    }
  });

  it('composes with an existing compatibility preload in NODE_OPTIONS', async () => {
    const existingImport = '--import=file:///existing/chrome-devtools-auto-connect-patch.js';
    const handoff = createChromeDevtoolsRelayHandoff({ NODE_OPTIONS: existingImport }, `Bearer ${'i'.repeat(43)}`);
    try {
      expect(handoff.env.NODE_OPTIONS).toContain(existingImport);
      expect(handoff.env.NODE_OPTIONS).toContain(`--import=${pathToFileURL(handoff.preloadPath).href}`);
    } finally {
      await handoff.close();
    }
  });

  it.runIf(process.platform === 'win32')(
    'creates a current-user-only protected Windows directory and removes it',
    async () => {
      const handoff = createChromeDevtoolsRelayHandoff(
        { ...process.env } as Record<string, string>,
        `Bearer ${'j'.repeat(43)}`
      );
      const directory = path.dirname(handoff.handoffPath);
      try {
        expect(await inspectWindowsAcl(directory)).toEqual({
          accessRuleCount: 1,
          accessRuleType: 'Allow',
          currentUserOwnsDirectory: true,
          fullControl: true,
          inherited: false,
          protected: true,
        });
      } finally {
        await handoff.close();
      }
      await expect(fs.stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );
});

async function expectRejectedHandoff(mutate: (handoff: ChromeDevtoolsRelayHandoff) => Promise<void>): Promise<void> {
  const authorization = `Bearer ${'g'.repeat(43)}`;
  const handoff = createChromeDevtoolsRelayHandoff({ ...process.env } as Record<string, string>, authorization);
  try {
    await mutate(handoff);
    const result = await runNode([TARGET, ENDPOINT], handoff.env);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('MCPorter Chrome relay authorization handoff unavailable.');
    expect(result.stderr).not.toContain(handoff.handoffPath);
    expect(result.stderr).not.toContain(authorization);
  } finally {
    await handoff.close();
  }
}

async function expectProtectedPath(filePath: string, kind: 'directory' | 'file', expectedMode: number): Promise<void> {
  const stat = await fs.lstat(filePath);
  expect(kind === 'directory' ? stat.isDirectory() : stat.isFile()).toBe(true);
  expect(stat.isSymbolicLink()).toBe(false);
  if (process.platform !== 'win32') {
    expect(stat.mode & 0o777).toBe(expectedMode);
    if (typeof process.getuid === 'function') expect(stat.uid).toBe(process.getuid());
  }
}

async function inspectWindowsAcl(directory: string): Promise<Record<string, unknown>> {
  const systemRoot = process.env.SystemRoot?.trim() || process.env.WINDIR?.trim();
  expect(systemRoot).toBeTruthy();
  expect(path.win32.isAbsolute(systemRoot!)).toBe(true);
  const powershell = path.win32.join(systemRoot!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const stat = await fs.lstat(powershell);
  expect(stat.isFile()).toBe(true);
  expect(stat.isSymbolicLink()).toBe(false);

  const result = spawnSync(
    powershell,
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      String.raw`
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$directory = New-Object System.IO.DirectoryInfo -ArgumentList @($env:MCPORTER_TEST_CHROME_RELAY_ACL_PATH)
$acl = $directory.GetAccessControl([System.Security.AccessControl.AccessControlSections]::All)
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))
$rule = $rules[0]
[PSCustomObject]@{
  accessRuleCount = $rules.Count
  accessRuleType = if ($rule) { $rule.AccessControlType.ToString() } else { '' }
  currentUserOwnsDirectory = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $sid.Value
  fullControl = if ($rule) { ($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -eq [System.Security.AccessControl.FileSystemRights]::FullControl } else { $false }
  inherited = if ($rule) { $rule.IsInherited } else { $false }
  protected = $acl.AreAccessRulesProtected
} | ConvertTo-Json -Compress
`,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, MCPORTER_TEST_CHROME_RELAY_ACL_PATH: directory },
      windowsHide: true,
    }
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

async function runNode(
  args: readonly string[],
  env: Record<string, string>
): Promise<{ code: number | null; spawnargs: readonly string[]; stdout: string; stderr: string }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, spawnargs: child.spawnargs, stdout, stderr }));
  });
}
