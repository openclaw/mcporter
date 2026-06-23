import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { metadataPathForArtifact, readCliMetadata } from '../src/cli-metadata.js';

describe('readCliMetadata', () => {
  it('prefers embedded metadata over stale sidecar metadata', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-metadata-'));
    const artifact = path.join(tempDir, 'artifact');
    const embedded = metadataPayload('embedded');
    const sidecar = metadataPayload('sidecar');
    await fs.writeFile(
      artifact,
      `#!/usr/bin/env node\nconsole.log(${JSON.stringify(JSON.stringify(embedded))});\n`,
      'utf8'
    );
    await fs.chmod(artifact, 0o755);
    await fs.writeFile(metadataPathForArtifact(artifact), JSON.stringify(sidecar), 'utf8');

    await expect(readCliMetadata(artifact)).resolves.toMatchObject({
      server: { name: 'embedded' },
    });
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
