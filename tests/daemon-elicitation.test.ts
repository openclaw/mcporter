import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DaemonBroker } from '../src/daemon/broker.js';
import { loadServerDefinitions } from '../src/config.js';
import { effectiveDefinition } from '../src/daemon/connection-identity.js';
import { NON_INTERACTIVE_ELICITATION_HINT } from '../src/runtime/elicitation.js';
import { makeShortTempDir } from './fixtures/test-helpers.js';
import { budget } from './helpers/timing.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODERN_SERVER = path.join(REPO_ROOT, 'tests', 'servers', 'modern', 'server.ts');
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

describe('daemon elicitation', () => {
  it(
    'returns an actionable CLI notice when a keep-alive call declines elicitation',
    async () => {
      const tempDir = await makeShortTempDir('daemon-elicitation');
      const configPath = path.join(tempDir, 'mcporter.json');
      await fs.writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            modern: {
              command: process.execPath,
              args: [TSX_CLI, MODERN_SERVER, '--stdio'],
              lifecycle: 'keep-alive',
              protocolVersion: '2026-07-28',
            },
          },
          imports: [],
        }),
        'utf8'
      );

      const broker = new DaemonBroker();
      const definitions = await Promise.all(
        (await loadServerDefinitions({ configPath })).map((definition) => effectiveDefinition(definition))
      );
      const handle = broker.register({ definitions });
      try {
        const response = {
          ok: true,
          ...(await broker.invokeWithNotices({
            id: 'elicitation-call',
            method: 'callTool',
            params: { server: 'modern', tool: 'confirm_delete', args: { target: 'fixture-item' } },
            ...handle,
          })),
        };
        expect(response.ok).toBe(true);
        expect(response.notices).toEqual([NON_INTERACTIVE_ELICITATION_HINT]);
        expect(JSON.stringify(response.result)).toContain('delete declined');
      } finally {
        await broker.close();
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    },
    budget(20_000)
  );
});
