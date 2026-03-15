import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleHeavyCli } from '../src/cli/heavy-command.js';

describe('mcporter heavy CLI', () => {
  let tempDir: string;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-heavy-'));
    configPath = path.join(tempDir, 'config', 'mcporter.json');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: {} }, null, 2), 'utf8');
    await fs.mkdir(path.join(tempDir, 'config', 'heavy', 'available'), { recursive: true });
    await fs.writeFile(
      path.join(tempDir, 'config', 'heavy', 'available', 'chrome-devtools.json'),
      JSON.stringify(
        {
          mcpServers: {
            'chrome-devtools': {
              command: 'npx',
              args: ['-y', 'chrome-devtools-mcp@latest'],
            },
          },
        },
        null,
        2
      ),
      'utf8'
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('activates a heavy MCP and writes an active marker', async () => {
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      if (typeof value === 'string') {
        logs.push(value);
      }
    });

    await handleHeavyCli(['activate', 'chrome-devtools'], { configPath, rootDir: tempDir });

    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(config.mcpServers['chrome-devtools']?.command).toBe('npx');
    await expect(
      fs.lstat(path.join(tempDir, 'config', 'heavy', 'active', 'chrome-devtools.json'))
    ).resolves.toBeTruthy();
    expect(logs).toContain('Activated: chrome-devtools');

    logSpy.mockRestore();
  });

  it('lists config-backed heavy MCPs as active even without marker files', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            'chrome-devtools': {
              command: 'npx',
              args: ['-y', 'chrome-devtools-mcp@latest'],
            },
          },
        },
        null,
        2
      ),
      'utf8'
    );

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      if (typeof value === 'string') {
        logs.push(value);
      }
    });

    await handleHeavyCli(['list'], { configPath, rootDir: tempDir });

    expect(logs.join('\n')).toContain('chrome-devtools [active]');

    logSpy.mockRestore();
  });

  it('deactivates a heavy MCP and removes its config entry', async () => {
    await handleHeavyCli(['activate', 'chrome-devtools'], { configPath, rootDir: tempDir });

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      if (typeof value === 'string') {
        logs.push(value);
      }
    });

    await handleHeavyCli(['deactivate', 'chrome-devtools'], { configPath, rootDir: tempDir });

    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(config.mcpServers['chrome-devtools']).toBeUndefined();
    await expect(fs.access(path.join(tempDir, 'config', 'heavy', 'active', 'chrome-devtools.json'))).rejects.toThrow();
    expect(logs).toContain('Deactivated: chrome-devtools');

    logSpy.mockRestore();
  });
});
