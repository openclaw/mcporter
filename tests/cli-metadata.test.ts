import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { metadataPathForArtifact, readCliMetadata } from '../src/cli-metadata.js';

describe('readCliMetadata', () => {
  it('prefers embedded metadata over stale sidecar metadata', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-metadata-'));
    const artifact = path.join(tempDir, process.platform === 'win32' ? 'artifact.exe' : 'artifact');
    const embedded = metadataPayload('embedded');
    const sidecar = metadataPayload('sidecar');
    const previousEmbeddedMetadata = process.env.MCPORTER_TEST_EMBEDDED_METADATA;
    const previousNodeOptions = process.env.NODE_OPTIONS;
    process.env.MCPORTER_TEST_EMBEDDED_METADATA = JSON.stringify(embedded);
    if (process.platform === 'win32') {
      const preload = path.join(tempDir, 'inspect-preload.cjs');
      await fs.copyFile(process.execPath, artifact);
      await fs.writeFile(
        preload,
        'console.log(process.env.MCPORTER_TEST_EMBEDDED_METADATA); process.exit(0);\n',
        'utf8'
      );
      const requirePath = preload.replaceAll(path.sep, path.posix.sep);
      process.env.NODE_OPTIONS = `${previousNodeOptions ? `${previousNodeOptions} ` : ''}--require ${requirePath}`;
    } else {
      const artifactContent = '#!/usr/bin/env node\nconsole.log(process.env.MCPORTER_TEST_EMBEDDED_METADATA);\n';
      await fs.writeFile(artifact, artifactContent, 'utf8');
      await fs.chmod(artifact, 0o755);
    }
    await fs.writeFile(metadataPathForArtifact(artifact), JSON.stringify(sidecar), 'utf8');

    try {
      await expect(readCliMetadata(artifact)).resolves.toMatchObject({
        server: { name: 'embedded' },
      });
    } finally {
      if (previousEmbeddedMetadata === undefined) {
        delete process.env.MCPORTER_TEST_EMBEDDED_METADATA;
      } else {
        process.env.MCPORTER_TEST_EMBEDDED_METADATA = previousEmbeddedMetadata;
      }
      if (previousNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = previousNodeOptions;
      }
    }
  });

  it('falls back to a legacy sidecar when the artifact cannot be executed', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-metadata-sidecar-'));
    const artifact = path.join(tempDir, 'missing-artifact');
    await fs.writeFile(metadataPathForArtifact(artifact), JSON.stringify(metadataPayload('legacy')), 'utf8');
    try {
      await expect(readCliMetadata(artifact)).resolves.toMatchObject({ server: { name: 'legacy' } });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves sidecar parse errors instead of masking them with the embedded error', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-metadata-invalid-'));
    const artifact = path.join(tempDir, 'missing-artifact');
    await fs.writeFile(metadataPathForArtifact(artifact), '{ invalid json', 'utf8');
    try {
      await expect(readCliMetadata(artifact)).rejects.toThrow(/JSON|position|property/u);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('reports executable inspection failures with stderr and exit code', async () => {
    await expect(readCliMetadata(process.execPath)).rejects.toThrow(/Failed to inspect CLI artifact[\s\S]*exit code/u);
  });
});

function metadataPayload(name: string) {
  return {
    schemaVersion: 1,
    generatedAt: '1970-01-01T00:00:00.000Z',
    generator: { name: 'mcporter', version: 'test' },
    server: {
      name,
      definition: {
        name,
        command: { kind: 'stdio' as const, command: 'node', args: [], cwd: process.cwd() },
      },
    },
    artifact: { path: '', kind: 'template' as const },
    invocation: { runtime: 'node' as const, timeoutMs: 30_000, minify: false },
  };
}
