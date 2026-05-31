import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCPORTER_VERSION } from '../src/runtime.js';
import type { RecordedMessage } from '../src/runtime/record-transport.js';

process.env.MCPORTER_DISABLE_AUTORUN = '1';
const cliModulePromise = import('../src/cli.js');

const originalEnv = { ...process.env };

describe('record/replay CLI close behavior', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
    process.env = { ...originalEnv, MCPORTER_DISABLE_AUTORUN: '1' };
  });

  it('fails replay commands when normal CLI cleanup leaves recorded requests unused', async () => {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-replay-cli-close-'));
    const configPath = path.join(tempHome, 'mcporter.json');
    const recordingPath = path.join(tempHome, '.mcporter', 'recordings', 'partial.ndjson');
    await writeReplayFixture(configPath, recordingPath);

    process.env.HOME = tempHome;
    process.env.MCPORTER_REPLAY = 'partial';
    process.env.MCPORTER_REPLAY_SERVER = 'linear';
    process.env.MCPORTER_NO_FORCE_EXIT = '1';

    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runCli } = await cliModulePromise;

    await expect(runCli(['--config', configPath, 'call', 'linear.first', '--output', 'json'])).rejects.toThrow(
      'Replay ended for server \'linear\' with 1 recorded request still unused; next expected recv tools/call {"name":"second","arguments":{}}.'
    );
    expect(logSpy).toHaveBeenCalled();

    await fs.rm(tempHome, { recursive: true, force: true });
  });
});

async function writeReplayFixture(configPath: string, recordingPath: string): Promise<void> {
  await fs.writeFile(
    configPath,
    JSON.stringify({
      mcpServers: {
        linear: {
          description: 'Replay-only test server',
          command: process.execPath,
          args: ['-e', 'process.exit(1)'],
        },
      },
    }),
    'utf8'
  );
  await fs.mkdir(path.dirname(recordingPath), { recursive: true });
  await fs.writeFile(
    recordingPath,
    [
      send('linear', 0, 'initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'mcporter', version: MCPORTER_VERSION },
      }),
      recv('linear', 0, {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'replay-fixture', version: '1.0.0' },
      }),
      notification('linear', 'notifications/initialized'),
      send('linear', 1, 'tools/call', { name: 'first', arguments: {} }),
      recv('linear', 1, { content: [] }),
      send('linear', 2, 'tools/call', { name: 'second', arguments: {} }),
      recv('linear', 2, { content: [] }),
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n',
    'utf8'
  );
}

function send(server: string, id: number | undefined, method: string, params: unknown): RecordedMessage {
  return {
    jsonrpc: '2.0',
    ...(id === undefined ? {} : { id }),
    method,
    params,
    _meta: { dir: 'send', server, ts: '2026-05-16T00:00:00.000Z' },
  } as RecordedMessage;
}

function recv(server: string, id: number, result: unknown): RecordedMessage {
  return {
    jsonrpc: '2.0',
    id,
    result,
    _meta: { dir: 'recv', server, ts: '2026-05-16T00:00:00.000Z' },
  } as RecordedMessage;
}

function notification(server: string, method: string): RecordedMessage {
  return {
    jsonrpc: '2.0',
    method,
    _meta: { dir: 'send', server, ts: '2026-05-16T00:00:00.000Z' },
  } as RecordedMessage;
}
