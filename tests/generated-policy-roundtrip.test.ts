import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { resolveServerDefinition } from '../src/cli/generate/definition.js';
import { resolveGenerateRequestFromArtifact } from '../src/cli/generate/template-data.js';
import { readCliMetadata, serializeDefinition } from '../src/cli-metadata.js';
import { generateCli } from '../src/generate-cli.js';
import { isKeepAliveServer, keepAliveIdleTimeout } from '../src/lifecycle.js';

it('preserves explicit keep-alive settings when serializing and resolving a regeneration target', async () => {
  const definition = {
    name: 'custom-policy',
    command: { kind: 'stdio' as const, command: 'node', args: ['server.mjs'], cwd: process.cwd() },
    lifecycle: { mode: 'keep-alive' as const, idleTimeoutMs: 12345 },
    logging: { daemon: { enabled: false } },
  };
  const roundtrip = await resolveServerDefinition(JSON.stringify(serializeDefinition(definition)));
  expect(isKeepAliveServer(roundtrip.definition)).toBe(true);
  expect(keepAliveIdleTimeout(roundtrip.definition)).toBe(12345);
  expect(roundtrip.definition.logging).toEqual(definition.logging);
});

it('keeps an explicit ephemeral override in actual generated artifact metadata', async () => {
  await fs.mkdir(path.join(process.cwd(), 'tmp'), { recursive: true });
  const dir = await fs.mkdtemp(path.join(process.cwd(), 'tmp', 'mcporter-policy-artifact-'));
  try {
    const output = path.join(dir, 'fixture.ts');
    await generateCli({
      serverRef: JSON.stringify({
        name: 'custom-policy',
        command: {
          kind: 'stdio',
          command: process.execPath,
          args: [fileURLToPath(new URL('./fixtures/stdio-emit-ts-server.mjs', import.meta.url)), 'playwright/mcp'],
          cwd: process.cwd(),
        },
        protocolVersion: 'legacy',
        lifecycle: { mode: 'ephemeral' },
        logging: { daemon: { enabled: false } },
      }),
      runtime: 'node',
      outputPath: output,
    });
    const metadata = await readCliMetadata(output);
    const request = resolveGenerateRequestFromArtifact({ from: output }, metadata, {});
    const { definition } = await resolveServerDefinition(request.serverRef);
    expect(metadata.server.definition).toMatchObject({
      lifecycle: { mode: 'ephemeral' },
      logging: { daemon: { enabled: false } },
    });
    expect(definition.lifecycle).toEqual({ mode: 'ephemeral' });
    expect(isKeepAliveServer(definition)).toBe(false);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
