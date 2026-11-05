import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadServerDefinitions } from '../src/config.js';

const TMP_PREFIX = path.join(os.tmpdir(), 'mcporter-command-');

let tmpDir: string | undefined;

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe('command string parsing', () => {
  it('splits whitespace-delimited command strings into executable + args', async () => {
    tmpDir = await fs.mkdtemp(TMP_PREFIX);
    const configDir = path.join(tmpDir, 'config');
    await fs.mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, 'mcporter.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          xcodebuild: {
            description: 'test server',
            command: 'npx -y xcodebuildmcp@latest',
          },
        },
        imports: [],
      })
    );

    const servers = await loadServerDefinitions({
      configPath,
      rootDir: tmpDir,
    });

    expect(servers).toHaveLength(1);
    const server = servers[0];
    if (!server) {
      throw new Error('expected server definition');
    }
    expect(server.command.kind).toBe('stdio');
    if (server.command.kind !== 'stdio') {
      throw new Error('expected stdio command');
    }
    expect(server.command.command).toBe('npx');
    expect(server.command.args).toEqual(['-y', 'xcodebuildmcp@latest']);
    expect(server.source).toEqual({
      kind: 'local',
      path: configPath,
    });
  });

  it('respects quoted segments inside command strings', async () => {
    tmpDir = await fs.mkdtemp(TMP_PREFIX);
    const configDir = path.join(tmpDir, 'config');
    await fs.mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, 'mcporter.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          bash: {
            command: 'bash -lc "echo \'hello world\'"',
          },
        },
        imports: [],
      })
    );

    const servers = await loadServerDefinitions({
      configPath,
      rootDir: tmpDir,
    });

    const server = servers[0];
    if (!server) {
      throw new Error('expected server definition');
    }
    expect(server.command.kind).toBe('stdio');
    if (server.command.kind !== 'stdio') {
      throw new Error('expected stdio command');
    }
    expect(server.command.command).toBe('bash');
    expect(server.command.args).toEqual(['-lc', "echo 'hello world'"]);
    expect(server.source).toEqual({
      kind: 'local',
      path: configPath,
    });
  });

  it('preserves existing executable paths that contain spaces', async () => {
    tmpDir = await fs.mkdtemp(TMP_PREFIX);
    const binDir = path.join(tmpDir, 'Application Bundle.app', 'Contents', 'MacOS');
    await fs.mkdir(binDir, { recursive: true });
    const executable = path.join(binDir, 'HopperMCPServer');
    await fs.writeFile(executable, '#!/bin/sh\nexit 0\n');
    await fs.chmod(executable, 0o755);

    const configDir = path.join(tmpDir, 'config');
    await fs.mkdir(configDir, { recursive: true });
    const configPath = path.join(configDir, 'mcporter.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          hopper: {
            command: executable,
          },
        },
        imports: [],
      })
    );

    const servers = await loadServerDefinitions({
      configPath,
      rootDir: tmpDir,
    });

    const server = servers[0];
    if (!server) {
      throw new Error('expected server definition');
    }
    expect(server.command.kind).toBe('stdio');
    if (server.command.kind !== 'stdio') {
      throw new Error('expected stdio command');
    }
    expect(server.command.command).toBe(executable);
    expect(server.command.args).toEqual([]);
  });

  it.each([
    { command: 'node --label "" after', args: ['--label', '', 'after'] },
    { command: "node '' first", args: ['', 'first'] },
    { command: 'node first ""', args: ['first', ''] },
    { command: "node first ''", args: ['first', ''] },
    { command: `node "" '' ""`, args: ['', '', ''] },
    { command: 'node  ""   after  ', args: ['', 'after'] },
    { command: `node pre""fix ''"value"`, args: ['prefix', 'value'] },
    { command: `node ' ' ""`, args: [' ', ''] },
  ])('preserves quoted arguments in $command', async ({ command, args }) => {
    tmpDir = await fs.mkdtemp(TMP_PREFIX);
    const configPath = path.join(tmpDir, 'mcporter.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        imports: [],
        mcpServers: { echo: { command } },
      })
    );

    const servers = await loadServerDefinitions({ configPath, rootDir: tmpDir });

    expect(servers[0]?.command).toMatchObject({
      kind: 'stdio',
      command: 'node',
      args,
    });
  });

  it('rejects an empty quoted executable instead of promoting an argument', async () => {
    tmpDir = await fs.mkdtemp(TMP_PREFIX);
    const configPath = path.join(tmpDir, 'mcporter.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        imports: [],
        mcpServers: { empty: { command: '"" node' } },
      })
    );

    await expect(loadServerDefinitions({ configPath, rootDir: tmpDir })).rejects.toThrow(
      "Server 'empty' is missing a baseUrl/url or command definition"
    );
  });
});
