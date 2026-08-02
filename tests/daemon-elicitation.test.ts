import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { __testProcessRequest, loadDaemonRuntimeState } from '../src/daemon/host.js';
import type { DaemonResponse } from '../src/daemon/protocol.js';
import { NON_INTERACTIVE_ELICITATION_HINT } from '../src/runtime/elicitation.js';
import { makeShortTempDir } from './fixtures/test-helpers.js';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODERN_SERVER = path.join(REPO_ROOT, 'tests', 'servers', 'modern', 'server.ts');
const TSX_CLI = createRequire(import.meta.url).resolve('tsx/cli');

describe('daemon elicitation', () => {
  it('returns an actionable CLI notice when a keep-alive call declines elicitation', async () => {
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

    const { runtime } = await loadDaemonRuntimeState({ configPath });
    try {
      const definition = runtime.getDefinition('modern');
      const result = await __testProcessRequest(
        '',
        runtime,
        new Map<string, ServerDefinition>([['modern', definition]]),
        new Map(),
        {
          configPath,
          configLayers: [],
          configMtimeMs: null,
          socketPath: path.join(tempDir, 'daemon.sock'),
          startedAt: Date.now(),
          logPath: null,
        },
        { enabled: false, logAllServers: false, servers: new Set() },
        {
          id: 'elicitation-call',
          method: 'callTool',
          params: { server: 'modern', tool: 'confirm_delete', args: { target: 'fixture-item' } },
        }
      );
      const response = result.response as DaemonResponse & { notices?: string[] };

      expect(response.ok).toBe(true);
      expect(response.notices).toEqual([NON_INTERACTIVE_ELICITATION_HINT]);
      expect(JSON.stringify(response.result)).toContain('delete declined');
    } finally {
      await runtime.close().catch(() => {});
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 20_000);
});
