import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { patchChromeDevtoolsMcp } from '../src/chrome-devtools-auto-connect-patch.js';
import {
  applyChromeDevtoolsCompat,
  resolveChromeDevtoolsCompatPatchPath,
  shouldApplyChromeDevtoolsCompat,
} from '../src/chrome-devtools-compat.js';

describe('chrome-devtools compatibility', () => {
  afterEach(() => {
    delete process.env.MCPORTER_DISABLE_CHROME_DEVTOOLS_COMPAT;
  });

  it('enables the patch for autoConnect chrome-devtools commands', () => {
    expect(shouldApplyChromeDevtoolsCompat('npx', ['-y', 'chrome-devtools-mcp@latest', '--autoConnect'])).toBe(true);
    expect(shouldApplyChromeDevtoolsCompat('npx', ['-y', 'chrome-devtools-mcp', '--auto-connect'])).toBe(true);
  });

  it('does not patch non-autoConnect commands', () => {
    expect(shouldApplyChromeDevtoolsCompat('npx', ['-y', 'chrome-devtools-mcp@latest'])).toBe(false);
  });

  it('allows opting out of the compatibility patch', () => {
    process.env.MCPORTER_DISABLE_CHROME_DEVTOOLS_COMPAT = '1';

    expect(shouldApplyChromeDevtoolsCompat('npx', ['-y', 'chrome-devtools-mcp@latest', '--autoConnect'])).toBe(false);
  });

  it('allows opting out from the merged server env', () => {
    const result = applyChromeDevtoolsCompat({ MCPORTER_DISABLE_CHROME_DEVTOOLS_COMPAT: '1' }, 'npx', [
      '-y',
      'chrome-devtools-mcp@latest',
      '--autoConnect',
    ]);

    expect(result).toEqual({ env: { MCPORTER_DISABLE_CHROME_DEVTOOLS_COMPAT: '1' }, applied: false });
  });

  it('injects a NODE_OPTIONS import for matching commands', () => {
    const result = applyChromeDevtoolsCompat({}, 'npx', ['-y', 'chrome-devtools-mcp@latest', '--autoConnect']);

    expect(result.applied).toBe(true);
    expect(result.env.NODE_OPTIONS).toContain('--import=file://');
    expect(result.env.NODE_OPTIONS).toContain('chrome-devtools-auto-connect-patch.js');
  });

  it('preserves existing NODE_OPTIONS', () => {
    const result = applyChromeDevtoolsCompat({ NODE_OPTIONS: '--trace-warnings' }, 'npx', [
      '-y',
      'chrome-devtools-mcp@latest',
      '--autoConnect',
    ]);

    expect(result.applied).toBe(true);
    expect(result.env.NODE_OPTIONS).toContain('--trace-warnings');
    expect(result.env.NODE_OPTIONS).toContain('chrome-devtools-auto-connect-patch.js');
  });

  it('materializes a JavaScript fallback patch when build output is missing', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-cdpmcp-fallback-'));

    const patchPath = resolveChromeDevtoolsCompatPatchPath([], tmp);

    expect(patchPath).toBe(path.join(tmp, 'mcporter-chrome-devtools-auto-connect-patch.js'));
    await expect(fs.readFile(patchPath!, 'utf8')).resolves.toContain('MCPORTER_DEVTOOLS_TIMEOUT_PATCH');
  });

  it('patches an npx .bin symlink target idempotently', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-cdpmcp-'));
    const packageBinDir = path.join(tmp, 'node_modules/chrome-devtools-mcp/build/src/bin');
    const binDir = path.join(tmp, 'node_modules/.bin');
    const contextPath = path.join(tmp, 'node_modules/chrome-devtools-mcp/build/src/McpContext.js');
    const binPath = path.join(packageBinDir, 'chrome-devtools-mcp.js');
    const shimPath = path.join(binDir, 'chrome-devtools-mcp');

    await fs.mkdir(packageBinDir, { recursive: true });
    await fs.mkdir(binDir, { recursive: true });
    await fs.writeFile(binPath, '#!/usr/bin/env node\n');
    await fs.writeFile(
      contextPath,
      `const NAVIGATION_TIMEOUT = 10_000;
async function detect(page, mcpPage) {
                if (await page.hasDevTools()) {
                    mcpPage.devToolsPage = await page.openDevTools();
                }
}
`
    );
    await fs.symlink('../chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js', shimPath);

    patchChromeDevtoolsMcp(shimPath);
    patchChromeDevtoolsMcp(shimPath);

    const patched = await fs.readFile(contextPath, 'utf8');
    expect(patched.match(/MCPORTER_DEVTOOLS_TIMEOUT_PATCH/g)).toHaveLength(1);
    expect(patched).toContain('mcporterWithTimeout(page.hasDevTools(), false)');
    expect(patched).toContain('mcporterWithTimeout(page.openDevTools(), undefined)');
  });
});
