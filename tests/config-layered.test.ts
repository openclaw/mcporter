import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadServerDefinitions } from '../src/config.js';

describe('loadServerDefinitions with layered configs', () => {
  let tempHomeDir: string | undefined;
  let tempProjectDir: string | undefined;
  let homedirSpy: { mockRestore(): void } | undefined;
  let previousEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tempHomeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-layered-home-'));
    tempProjectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-layered-project-'));
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tempHomeDir);
    previousEnv = {
      HOME: process.env.HOME,
      USERPROFILE: process.env.USERPROFILE,
      APPDATA: process.env.APPDATA,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      MCPORTER_CONFIG: process.env.MCPORTER_CONFIG,
    };
    process.env.HOME = tempHomeDir;
    process.env.USERPROFILE = tempHomeDir;
    process.env.APPDATA = path.join(tempHomeDir, 'AppData', 'Roaming');
    process.env.XDG_CONFIG_HOME = path.join(tempHomeDir, '.config');
    delete process.env.MCPORTER_CONFIG;
  });

  afterEach(async () => {
    homedirSpy?.mockRestore();
    homedirSpy = undefined;
    for (const key of Object.keys(previousEnv)) {
      const typedKey = key as keyof typeof previousEnv;
      const value = previousEnv[typedKey];
      if (value === undefined) {
        delete process.env[typedKey];
      } else {
        process.env[typedKey] = value;
      }
    }
    if (tempHomeDir) {
      await fs.rm(tempHomeDir, { recursive: true, force: true }).catch(() => {});
      tempHomeDir = undefined;
    }
    if (tempProjectDir) {
      await fs.rm(tempProjectDir, { recursive: true, force: true }).catch(() => {});
      tempProjectDir = undefined;
    }
  });

  it('merges home then project configs, allowing project to override', async () => {
    const homeDir =
      tempHomeDir ??
      (() => {
        throw new Error('tempHomeDir missing');
      })();
    const projectDir =
      tempProjectDir ??
      (() => {
        throw new Error('tempProjectDir missing');
      })();

    const homeConfigDir = path.join(homeDir, '.config', 'mcporter');
    await fs.mkdir(homeConfigDir, { recursive: true });
    await fs.writeFile(
      path.join(homeConfigDir, 'mcporter.json'),
      JSON.stringify(
        {
          mcpServers: {
            fromHome: { baseUrl: 'https://home.example.com/mcp' },
            overrideMe: { baseUrl: 'https://home-override.example.com/mcp' },
          },
        },
        null,
        2
      )
    );

    const projectConfigDir = path.join(projectDir, 'config');
    await fs.mkdir(projectConfigDir, { recursive: true });
    await fs.writeFile(
      path.join(projectConfigDir, 'mcporter.json'),
      JSON.stringify(
        {
          mcpServers: {
            fromProject: { baseUrl: 'https://project.example.com/mcp' },
            overrideMe: { baseUrl: 'https://project-override.example.com/mcp' },
          },
        },
        null,
        2
      )
    );

    const servers = await loadServerDefinitions({ rootDir: projectDir });
    const names = servers.map((server) => server.name).toSorted();
    expect(names).toEqual(['fromHome', 'fromProject', 'overrideMe']);

    const merged = Object.fromEntries(servers.map((server) => [server.name, server]));
    const override = merged.overrideMe;
    const fromHome = merged.fromHome;
    const fromProject = merged.fromProject;

    expect(override).toBeDefined();
    expect(fromHome).toBeDefined();
    expect(fromProject).toBeDefined();

    if (!override || override.command.kind !== 'http') {
      throw new Error('overrideMe should be an http server');
    }
    if (!fromHome || fromHome.command.kind !== 'http') {
      throw new Error('fromHome should be an http server');
    }
    if (!fromProject || fromProject.command.kind !== 'http') {
      throw new Error('fromProject should be an http server');
    }

    expect(override.command.url.href).toBe('https://project-override.example.com/mcp');
    expect(fromHome.command.url.href).toBe('https://home.example.com/mcp');
    expect(fromProject.command.url.href).toBe('https://project.example.com/mcp');
  });

  it('falls back to home config when project config is missing', async () => {
    const homeDir =
      tempHomeDir ??
      (() => {
        throw new Error('tempHomeDir missing');
      })();
    const projectDir =
      tempProjectDir ??
      (() => {
        throw new Error('tempProjectDir missing');
      })();

    const homeConfigDir = path.join(homeDir, '.config', 'mcporter');
    await fs.mkdir(homeConfigDir, { recursive: true });
    await fs.writeFile(
      path.join(homeConfigDir, 'mcporter.json'),
      JSON.stringify({ mcpServers: { fromHome: { baseUrl: 'https://home.example.com/mcp' } } }, null, 2)
    );

    const servers = await loadServerDefinitions({ rootDir: projectDir });
    expect(servers.map((server) => server.name)).toEqual(['fromHome']);
  });

  it('uses explicit config path without merging when set', async () => {
    const homeDir =
      tempHomeDir ??
      (() => {
        throw new Error('tempHomeDir missing');
      })();
    const projectDir =
      tempProjectDir ??
      (() => {
        throw new Error('tempProjectDir missing');
      })();

    const homeConfigDir = path.join(homeDir, '.config', 'mcporter');
    await fs.mkdir(homeConfigDir, { recursive: true });
    await fs.writeFile(
      path.join(homeConfigDir, 'mcporter.json'),
      JSON.stringify({ mcpServers: { fromHome: { baseUrl: 'https://home.example.com/mcp' } } }, null, 2)
    );

    const projectConfigDir = path.join(projectDir, 'config');
    await fs.mkdir(projectConfigDir, { recursive: true });
    const explicitPath = path.join(projectConfigDir, 'mcporter.json');
    await fs.writeFile(
      explicitPath,
      JSON.stringify({ mcpServers: { onlyProject: { baseUrl: 'https://project.example.com/mcp' } } }, null, 2)
    );

    const servers = await loadServerDefinitions({ configPath: explicitPath, rootDir: projectDir });
    expect(servers.map((server) => server.name)).toEqual(['onlyProject']);
  });
});
