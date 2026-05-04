import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleAddCommand } from '../src/cli/config/add.js';
import type { LoadConfigOptions } from '../src/config.js';

describe('config add scope behavior', () => {
  const originalEnv = { ...process.env };
  let projectDir: string;
  let homeDir: string;
  let loadOptions: LoadConfigOptions;
  let restoreHomedir: (() => void) | undefined;

  beforeEach(async () => {
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-add-scope-project-'));
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-add-scope-home-'));
    loadOptions = { rootDir: projectDir };
    const spy = vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
    restoreHomedir = () => spy.mockRestore();
    delete process.env.XDG_CONFIG_HOME;
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    restoreHomedir?.();
    restoreHomedir = undefined;
    await fs.rm(projectDir, { recursive: true, force: true });
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it('writes to XDG config home when scope=home and XDG_CONFIG_HOME is set', async () => {
    const xdgConfigHome = path.join(homeDir, '.config');
    process.env.XDG_CONFIG_HOME = xdgConfigHome;
    await handleAddCommand({ loadOptions } as never, ['xdghome', 'https://xdg.example/mcp', '--scope', 'home']);
    const homeConfigPath = path.join(xdgConfigHome, 'mcporter', 'mcporter.json');
    const buffer = await fs.readFile(homeConfigPath, 'utf8');
    const parsed = JSON.parse(buffer) as { mcpServers: Record<string, { baseUrl: string }> };
    expect(parsed.mcpServers.xdghome).toBeDefined();
    expect(parsed.mcpServers.xdghome?.baseUrl).toBe('https://xdg.example/mcp');
  });

  it('writes to home config when scope=home', async () => {
    await handleAddCommand({ loadOptions } as never, ['homescope', 'https://home.example/mcp', '--scope', 'home']);
    const homeConfigPath = path.join(homeDir, '.mcporter', 'mcporter.json');
    const buffer = await fs.readFile(homeConfigPath, 'utf8');
    const parsed = JSON.parse(buffer) as { mcpServers: Record<string, { baseUrl: string }> };
    expect(parsed.mcpServers.homescope).toBeDefined();
    expect(parsed.mcpServers.homescope?.baseUrl).toBe('https://home.example/mcp');
  });

  it('writes to project config when scope=project', async () => {
    await handleAddCommand({ loadOptions } as never, ['projects', 'https://project.example/mcp', '--scope', 'project']);
    const projectConfigPath = path.join(projectDir, 'config', 'mcporter.json');
    const buffer = await fs.readFile(projectConfigPath, 'utf8');
    const parsed = JSON.parse(buffer) as { mcpServers: Record<string, { baseUrl: string }> };
    expect(parsed.mcpServers.projects).toBeDefined();
    expect(parsed.mcpServers.projects?.baseUrl).toBe('https://project.example/mcp');
  });
});
