import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { resolveServerDefinition } from '../src/cli/generate/definition.js';
import { createRuntime } from '../src/runtime.js';

it('accepts the JSONC and URL aliases used by normal config loading', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-generate-jsonc-'));
  try {
    const config = path.join(dir, 'mcporter.json');
    await fs.writeFile(
      config,
      '{ // valid config comment\n "mcpServers": { "remote": { "baseUrl": "https://example.com/mcp", }, }, }'
    );
    const resolved = await resolveServerDefinition(config);
    expect(resolved.definition.command).toMatchObject({ kind: 'http', url: new URL('https://example.com/mcp') });
    expect(resolved.name).toBe('remote');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it('runs a file-selected stdio server in its config-relative working directory', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-generate-cwd-'));
  let runtime: Awaited<ReturnType<typeof createRuntime>> | undefined;
  try {
    await fs.mkdir(path.join(dir, 'server'));
    await fs.writeFile(path.join(dir, 'server', 'marker.txt'), 'owned working directory');
    const config = path.join(dir, 'mcporter.json');
    await fs.writeFile(
      config,
      JSON.stringify({
        mcpServers: {
          local: {
            command: process.execPath,
            args: [fileURLToPath(new URL('./fixtures/stdio-cwd-proof.mjs', import.meta.url))],
            cwd: './server',
            protocolVersion: 'legacy',
          },
        },
      })
    );
    const { definition } = await resolveServerDefinition(config);
    runtime = await createRuntime({ servers: [definition], configPath: config });
    const result = await runtime.callTool('local', 'read_marker', { args: {} });
    expect(result).toMatchObject({ content: [{ type: 'text', text: 'owned working directory' }] });
    expect(definition.source).toEqual({ kind: 'local', path: config });
  } finally {
    await runtime?.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it('retains normalized command-object files and first-entry selection', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-generate-legacy-'));
  try {
    const config = path.join(dir, 'mcporter.json');
    await fs.writeFile(
      config,
      JSON.stringify({
        mcpServers: {
          first: { command: { kind: 'stdio', command: 'node', args: ['first.mjs'], cwd: dir } },
          second: { command: 'node', args: ['second.mjs'] },
        },
      })
    );
    const resolved = await resolveServerDefinition(config);
    expect(resolved.name).toBe('first');
    expect(resolved.definition.command).toEqual({ kind: 'stdio', command: 'node', args: ['first.mjs'], cwd: dir });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
