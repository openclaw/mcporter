import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { singletonFixture } from './helpers/singleton.js';
import { fetchTools } from '../src/cli/generate/definition.js';
import { createRuntime } from '../src/runtime.js';
import { createGeneratedKeepAliveRuntime } from '../src/generated-daemon-runtime.js';
import { generateCli } from '../src/generate-cli.js';

it('uses one exclusive generic child for listing, automatic descriptions, generation, help and repeated discovery', async () => {
  const f = await singletonFixture({ exclusive: true });
  try {
    const client = f.client();
    expect(await client.listTools({ server: 'fixture' })).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'identity' })])
    );
    const discovered = await fetchTools(f.definition, 'fixture');
    expect(discovered.derivedDescription).toBe('Operate the synthetic fixture.');
    expect(await client.getServerMetadata({ server: 'fixture' })).toEqual({
      instructions: 'Operate the synthetic fixture.',
      serverInfo: { name: 'synthetic', version: '1', title: 'Synthetic tools' },
    });
    const bundle = path.join(f.root, 'generated.cjs');
    await generateCli({
      serverRef: JSON.stringify(f.definition),
      outputPath: path.join(f.root, 'generated.ts'),
      bundle,
      runtime: 'node',
    });
    const help = await promisify(execFile)(process.execPath, [bundle, '--help'], { cwd: f.root, env: process.env });
    expect(help.stdout).toContain('Operate the synthetic fixture.');
    expect(help.stdout).toContain('identity');
    expect((await fetchTools(f.definition, 'fixture')).derivedDescription).toBe(discovered.derivedDescription);
    const limited = f.client({ ...f.definition, name: 'limited', allowedTools: ['identity'] });
    expect(await limited.getServerMetadata({ server: 'limited' })).toEqual(
      await client.getServerMetadata({ server: 'fixture' })
    );
    await expect(limited.getServerMetadata({ server: 'fixture' })).rejects.toMatchObject({
      code: 'server_not_in_view',
    });
    await expect(limited.callTool({ server: 'limited', tool: 'secret' })).rejects.toMatchObject({
      code: 'tool_not_allowed',
    });
    expect((await fs.readFile(path.join(f.root, 'instances'), 'utf8')).trim().split('\n')).toHaveLength(1);
    expect(f.host.status().servers).toHaveLength(1);
    await Promise.all([client.release(), limited.release()]);
  } finally {
    await f.close();
  }
});

it('refuses raw/interactive pooled bypasses while preserving ephemeral connections and discovery', async () => {
  const f = await singletonFixture();
  const base = await createRuntime({ servers: [f.definition] });
  const raw = vi.spyOn(base, 'connect');
  const context = await createGeneratedKeepAliveRuntime(base, f.definition);
  try {
    await expect(context.runtime.connect('fixture')).rejects.toThrow('Raw connections');
    const options = { oauthSessionOptions: {} };
    await expect(context.runtime.listTools('fixture', options)).rejects.toThrow('Interactive OAuth');
    await expect(context.runtime.listResources('fixture', options)).rejects.toThrow('Interactive OAuth');
    await expect(context.runtime.readResource('fixture', 'fixture://x', options)).rejects.toThrow('Interactive OAuth');
    await expect(context.runtime.getServerMetadata!('fixture', options)).rejects.toThrow('Interactive OAuth');
    expect((await context.runtime.getServerMetadata!('fixture')).instructions).toBe('Operate the synthetic fixture.');
    expect(await context.runtime.getInstructions!('fixture')).toBeUndefined();
    expect(raw).not.toHaveBeenCalled();
    const ephemeral = { ...f.definition, lifecycle: { mode: 'ephemeral' as const } };
    const local = await createRuntime({ servers: [ephemeral] });
    const localContext = await createGeneratedKeepAliveRuntime(local, ephemeral);
    try {
      expect(localContext.runtime).toBe(local);
      expect((await localContext.runtime.connect('fixture')).client.getInstructions()).toBe(
        'Operate the synthetic fixture.'
      );
    } finally {
      await localContext.close();
    }
    expect((await fetchTools(ephemeral, 'fixture')).derivedDescription).toBe('Operate the synthetic fixture.');
  } finally {
    await context.close();
    await f.close();
  }
});

it.each([false, true])('preserves explicit ephemeral discovery with config (same-name entry=%s)', async (conflict) => {
  const f = await singletonFixture();
  try {
    const configPath = path.join(f.root, 'discovery.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        imports: [],
        mcpServers: conflict ? { fixture: { command: process.execPath, args: ['-e', 'process.exit(1)'] } } : {},
      })
    );
    const definition = { ...f.definition, lifecycle: { mode: 'ephemeral' as const }, allowedTools: ['identity'] };
    const discovered = await fetchTools(definition, 'fixture', configPath);
    expect(discovered.tools.map((tool) => tool.name)).toEqual(['identity']);
    expect(discovered.derivedDescription).toBe('Operate the synthetic fixture.');
  } finally {
    await f.close();
  }
});
