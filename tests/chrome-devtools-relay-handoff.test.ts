import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
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
const ENDPOINT = 'ws://127.0.0.1:45678/cdp';
const STABLE_RELAY_TOKEN = 'stable-relay-token-must-not-appear';

describe('chrome-devtools relay preload handoff', () => {
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
