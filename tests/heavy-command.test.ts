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
    await writeHeavyDefinition('chrome-devtools', ['chrome-devtools']);
    await writeHeavyDefinition('playwright', ['playwright']);
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
    const marker = JSON.parse(
      await fs.readFile(path.join(tempDir, 'config', 'heavy', 'active', 'chrome-devtools.json'), 'utf8')
    ) as { serverNames: string[] };
    expect(marker.serverNames).toEqual(['chrome-devtools']);
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

  it('does not list stale markers as active heavy MCPs', async () => {
    const activePath = path.join(tempDir, 'config', 'heavy', 'active', 'chrome-devtools.json');
    await fs.mkdir(path.dirname(activePath), { recursive: true });
    await fs.writeFile(
      activePath,
      JSON.stringify({ activated: 'already', serverNames: ['chrome-devtools'] }, null, 2),
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
    expect(output).toContain('  chrome-devtools');
    expect(output).not.toContain('chrome-devtools [active]');

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

  it('rejects empty heavy definitions with a validation error', async () => {
    await fs.writeFile(path.join(availableDir, 'empty.json'), JSON.stringify({ mcpServers: {} }, null, 2), 'utf8');

    await expect(handleHeavyCli(['activate', 'empty'], { configPath, rootDir: tempDir })).rejects.toThrow(
      /Invalid heavy MCP definition 'empty'.*must contain at least one server/
    );
  });

  it('ignores unrelated invalid heavy definitions during activation and listing', async () => {
    await fs.writeFile(path.join(availableDir, 'broken.json'), JSON.stringify({ nope: true }, null, 2), 'utf8');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      if (typeof value === 'string') {
        logs.push(value);
      }
    });

    await expect(
      handleHeavyCli(['activate', 'chrome-devtools'], { configPath, rootDir: tempDir })
    ).resolves.toBeUndefined();
    await expect(handleHeavyCli(['list'], { configPath, rootDir: tempDir })).resolves.toBeUndefined();

    expect(logs.join('\n')).toContain('chrome-devtools [active]');
    expect(warnSpy).toHaveBeenCalled();

    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('ignores unrelated invalid heavy definitions during deactivate', async () => {
    await handleHeavyCli(['activate', 'chrome-devtools'], { configPath, rootDir: tempDir });
    await fs.writeFile(path.join(availableDir, 'broken.json'), JSON.stringify({ nope: true }, null, 2), 'utf8');
    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      if (typeof value === 'string') {
        logs.push(value);
      }
    });

    await expect(
      handleHeavyCli(['deactivate', 'chrome-devtools'], { configPath, rootDir: tempDir })
    ).resolves.toBeUndefined();

    expect(logs).toContain('Deactivated: chrome-devtools');

    logSpy.mockRestore();
  });

  it('rejects unsafe heavy MCP names before any filesystem writes', async () => {
    const originalConfig = await fs.readFile(configPath, 'utf8');

    await expect(handleHeavyCli(['activate', '../../mcporter'], { configPath, rootDir: tempDir })).rejects.toThrow(
      /Invalid heavy MCP name/
    );

    await expect(fs.readFile(configPath, 'utf8')).resolves.toBe(originalConfig);
  });

  it('reactivates when only a stale marker file remains', async () => {
    const activePath = path.join(tempDir, 'config', 'heavy', 'active', 'chrome-devtools.json');
    await fs.mkdir(path.dirname(activePath), { recursive: true });
    await fs.writeFile(
      activePath,
      JSON.stringify({ activated: 'already', serverNames: ['stale-server'] }, null, 2),
      'utf8'
    );

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      if (typeof value === 'string') {
        logs.push(value);
      }
    });

    await expect(
      handleHeavyCli(['activate', 'chrome-devtools'], { configPath, rootDir: tempDir })
    ).resolves.toBeUndefined();

    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(config.mcpServers['chrome-devtools']?.command).toBe('npx');
    const marker = JSON.parse(await fs.readFile(activePath, 'utf8')) as { serverNames: string[] };
    expect(marker.serverNames).toEqual(['chrome-devtools']);
    expect(logs).toContain('Activated: chrome-devtools');

    logSpy.mockRestore();
  });

  it('rejects activation when it would overwrite an existing server config', async () => {
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            'chrome-devtools': {
              command: 'node',
              args: ['custom-devtools.js'],
            },
          },
        },
        null,
        2
      ),
      'utf8'
    );

    const originalConfig = await fs.readFile(configPath, 'utf8');

    await expect(handleHeavyCli(['activate', 'chrome-devtools'], { configPath, rootDir: tempDir })).rejects.toThrow(
      /Cannot activate heavy MCP 'chrome-devtools' because these server entries already exist with different settings: 'chrome-devtools'/
    );

    await expect(fs.readFile(configPath, 'utf8')).resolves.toBe(originalConfig);
    await expect(fs.access(path.join(tempDir, 'config', 'heavy', 'active', 'chrome-devtools.json'))).rejects.toThrow();
  });

  it('does not deactivate drifted marker-backed configs when the definition still exists', async () => {
    await handleHeavyCli(['activate', 'playwright'], { configPath, rootDir: tempDir });
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

    await expect(
      handleHeavyCli(['deactivate', 'playwright'], { configPath, rootDir: tempDir })
    ).resolves.toBeUndefined();

    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(config.mcpServers.playwright).toEqual({
      command: 'node',
      args: ['custom-playwright.js'],
    });
    await expect(
      fs.readFile(path.join(tempDir, 'config', 'heavy', 'active', 'playwright.json'), 'utf8')
    ).resolves.toContain('playwright');
    expect(logs).toContain("Heavy MCP 'playwright' is not active.");

    logSpy.mockRestore();
  });

  it('deactivates an active heavy MCP even when its definition file becomes malformed', async () => {
    await handleHeavyCli(['activate', 'chrome-devtools'], { configPath, rootDir: tempDir });
    await fs.writeFile(
      path.join(availableDir, 'chrome-devtools.json'),
      JSON.stringify({ nope: true }, null, 2),
      'utf8'
    );

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      if (typeof value === 'string') {
        logs.push(value);
      }
    });

    await expect(
      handleHeavyCli(['deactivate', 'chrome-devtools'], { configPath, rootDir: tempDir })
    ).resolves.toBeUndefined();

    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(config.mcpServers['chrome-devtools']).toBeUndefined();
    await expect(fs.access(path.join(tempDir, 'config', 'heavy', 'active', 'chrome-devtools.json'))).rejects.toThrow();
    expect(logs).toContain('Deactivated: chrome-devtools');

    logSpy.mockRestore();
  });

  it('does not deactivate drifted marker-backed configs when the definition becomes malformed', async () => {
    await handleHeavyCli(['activate', 'chrome-devtools'], { configPath, rootDir: tempDir });
    await fs.writeFile(
      configPath,
      JSON.stringify(
        {
          mcpServers: {
            'chrome-devtools': {
              command: 'node',
              args: ['custom-devtools.js'],
            },
          },
        },
        null,
        2
      ),
      'utf8'
    );
    await fs.writeFile(
      path.join(availableDir, 'chrome-devtools.json'),
      JSON.stringify({ nope: true }, null, 2),
      'utf8'
    );

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      if (typeof value === 'string') {
        logs.push(value);
      }
    });

    await expect(
      handleHeavyCli(['deactivate', 'chrome-devtools'], { configPath, rootDir: tempDir })
    ).resolves.toBeUndefined();

    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(config.mcpServers['chrome-devtools']).toEqual({
      command: 'node',
      args: ['custom-devtools.js'],
    });
    await expect(
      fs.readFile(path.join(tempDir, 'config', 'heavy', 'active', 'chrome-devtools.json'), 'utf8')
    ).resolves.toContain('chrome-devtools');
    expect(logs).toContain("Heavy MCP 'chrome-devtools' is not active.");

    logSpy.mockRestore();
  });

  it('deactivates using marker metadata when the definition file is missing and names differ from the basename', async () => {
    await writeHeavyDefinition('browser-suite', ['playwright', 'chrome-devtools']);
    await handleHeavyCli(['activate', 'browser-suite'], { configPath, rootDir: tempDir });
    await fs.unlink(path.join(availableDir, 'browser-suite.json'));

    const logs: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((value?: unknown) => {
      if (typeof value === 'string') {
        logs.push(value);
      }
    });

    await expect(
      handleHeavyCli(['deactivate', 'browser-suite'], { configPath, rootDir: tempDir })
    ).resolves.toBeUndefined();

    const config = JSON.parse(await fs.readFile(configPath, 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(config.mcpServers['chrome-devtools']).toBeUndefined();
    expect(config.mcpServers.playwright).toBeUndefined();
    expect(logs).toContain('Deactivated: browser-suite');

    logSpy.mockRestore();
  });

  async function writeHeavyDefinition(name: string, serverNames: string[]): Promise<void> {
    await fs.writeFile(
      path.join(availableDir, `${name}.json`),
      JSON.stringify(
        {
          mcpServers: Object.fromEntries(
            serverNames.map((serverName) => [
              serverName,
              {
                command: 'npx',
                args: [`-y`, `${serverName}-mcp@latest`],
              },
            ])
          ),
        },
        null,
        2
      ),
      'utf8'
    );
  }
});
