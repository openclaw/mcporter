import { resolveRecordingPath } from '../runtime/record-transport.js';
import { parseReplayArgs } from './record-command.js';
import {
  buildRecordReplayInstructions,
  runRecordReplayCommand,
  writeRecordReplayConfig,
} from './record-replay-command.js';
import { buildReplayCommandEnv } from './record-replay-env.js';

export async function handleReplayCli(args: string[]): Promise<void> {
  const parsed = parseReplayArgs(args);
  const replayPath = resolveRecordingPath(parsed.sessionName);

  if (parsed.command.length > 0) {
    await runRecordReplayCommand(parsed.command, buildReplayCommandEnv(parsed.sessionName, parsed.server));
    return;
  }

  const configPath = await writeRecordReplayConfig(parsed, 'replay');
  console.log(`Replay configuration written to ${configPath}`);
  const envInstructions = buildRecordReplayInstructions('replay', parsed.sessionName, parsed.server);
  console.log(`Set ${envInstructions.join(' and ')} before the next mcporter call to replay ${replayPath}.`);
}

export function printReplayHelp(): void {
  console.log(`Usage: mcporter replay <session-name> [--server <name>] [-- <command-to-run>]

Replay MCP JSON-RPC traffic from ~/.mcporter/recordings/<session-name>.ndjson.

Flags:
  --server <name>  Restrict replay to one configured server.`);
}
