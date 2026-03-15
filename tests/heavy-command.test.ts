import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleHeavyCli } from '../src/cli/heavy-command.js';

describe('mcporter heavy CLI', () => {
  let tempDir: string;
  let configPath: string;
  let availableDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-heavy-'));
    configPath = path.join(tempDir, 'config', 'mcporter.json');
    availableDir = path.join(tempDir, 'config', 'heavy', 'available');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, JSON.stringify({ mcpServers: {} }, null, 2), 'utf8');
    await fs.mkdir(availableDir, { recursive: true });
    await writeHeavyDefinition('chrome-devtools');
    await writeHeavyDefinition('playwright');
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

  it('merges marker-based and config-backed heavy MCPs in mixed states', async () => {
    await handleHeavyCli(['activate', 'chrome-devtools'], { configPath, rootDir: tempDir });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            'chrome-devtools': {
              command: 'npx',
              args: ['-y', 'chrome-devtools-mcp@latest'],
            },
            playwright: {
              command: 'npx',
              args: ['-y', 'playwright-mcp@latest'],
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

    const output = logs.join('\n');
    expect(output).toContain('chrome-devtools [active]');
    expect(output).toContain('playwright [active]');

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

  it('deactivates config-backed heavy MCPs even when another heavy MCP has a marker', async () => {
    await handleHeavyCli(['activate', 'chrome-devtools'], { configPath, rootDir: tempDir });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            'chrome-devtools': {
              command: 'npx',
              args: ['-y', 'chrome-devtools-mcp@latest'],
            },
            playwright: {
              command: 'npx',
              args: ['-y', 'playwright-mcp@latest'],
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

    await handleHeavyCli(['deactivate', 'playwright'], { configPath, rootDir: tempDir });

    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(config.mcpServers.playwright).toBeUndefined();
    expect(config.mcpServers['chrome-devtools']).toBeDefined();
    expect(logs).toContain('Deactivated: playwright');

    logSpy.mockRestore();
  });

  it('does not treat same-name custom configs as active heavy MCPs', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            playwright: {
              command: 'node',
              args: ['custom-playwright.js'],
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

    const output = logs.join('\n');
    expect(output).toContain('  playwright');
    expect(output).not.toContain('playwright [active]');

    logSpy.mockRestore();
  });

  it('does not delete same-name custom configs during deactivate fallback', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            playwright: {
              command: 'node',
              args: ['custom-playwright.js'],
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

    await handleHeavyCli(['deactivate', 'playwright'], { configPath, rootDir: tempDir });

    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(config.mcpServers.playwright).toEqual({
      command: 'node',
      args: ['custom-playwright.js'],
    });
    expect(logs).toContain("Heavy MCP 'playwright' is not active.");

    logSpy.mockRestore();
  });

  it('rejects malformed heavy definitions with a validation error', async () => {
    await fs.writeFile(path.join(availableDir, 'broken.json'), JSON.stringify({ nope: true }, null, 2), 'utf8');

    await expect(handleHeavyCli(['activate', 'broken'], { configPath, rootDir: tempDir })).rejects.toThrow(
      /Invalid heavy MCP definition 'broken'/
    );
  });

  it('rejects unsafe heavy MCP names before any filesystem writes', async () => {
    const originalConfig = await fs.readFile(configPath, 'utf8');

    await expect(handleHeavyCli(['activate', '../../mcporter'], { configPath, rootDir: tempDir })).rejects.toThrow(
      /Invalid heavy MCP name/
    );

    await expect(fs.readFile(configPath, 'utf8')).resolves.toBe(originalConfig);
  });

  async function writeHeavyDefinition(name: 'chrome-devtools' | 'playwright'): Promise<void> {
    const args = name === 'chrome-devtools' ? ['-y', 'chrome-devtools-mcp@latest'] : ['-y', 'playwright-mcp@latest'];
    await fs.writeFile(
      path.join(availableDir, `${name}.json`),
      JSON.stringify(
        {
          mcpServers: {
            [name]: {
              command: 'npx',
              args,
            },
          },
        },
        null,
        2
      ),
      'utf8'
    );
  }
});
