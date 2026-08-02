import { resolveRecordingConfigPath, resolveRecordingPath } from '../runtime/record-transport.js';
import { buildRecordCommandEnv } from './record-replay-env.js';
import {
  buildRecordReplayInstructions,
  runRecordReplayCommand,
  writeRecordReplayConfig,
} from './record-replay-command.js';

export interface ParsedRecordArgs {
  readonly sessionName: string;
  readonly server?: string;
  readonly command: string[];
}

export async function handleRecordCli(args: string[]): Promise<void> {
  const parsed = parseRecordArgs(args);
  const recordPath = resolveRecordingPath(parsed.sessionName);

  if (parsed.command.length > 0) {
    await runRecordReplayCommand(parsed.command, buildRecordCommandEnv(parsed.sessionName, parsed.server));
    return;
  }

  await writeRecordReplayConfig(parsed, 'record');
  console.log(`Recording configuration written to ${resolveRecordingConfigPath(parsed.sessionName)}`);
  const envInstructions = buildRecordReplayInstructions('record', parsed.sessionName, parsed.server);
  console.log(`Set ${envInstructions.join(' and ')} before the next mcporter call to record ${recordPath}.`);
}

export function printRecordHelp(): void {
  console.log(`Usage: mcporter record <session-name> [--server <name>] [-- <command-to-run>]

Capture MCP JSON-RPC traffic to ~/.mcporter/recordings/<session-name>.ndjson.

Flags:
  --server <name>  Restrict recording to one configured server.`);
}

export function parseRecordArgs(args: string[]): ParsedRecordArgs {
  return parseSessionCommandArgs(args, 'record');
}

export function parseReplayArgs(args: string[]): ParsedRecordArgs {
  return parseSessionCommandArgs(args, 'replay');
}

function parseSessionCommandArgs(args: string[], commandName: 'record' | 'replay'): ParsedRecordArgs {
  let server: string | undefined;
  const tokens = [...args];
  const commandSeparator = tokens.indexOf('--');
  const command = commandSeparator === -1 ? [] : tokens.splice(commandSeparator);
  if (command[0] === '--') {
    command.shift();
  }

  const remaining: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }
    if (token === '--server') {
      const value = tokens[index + 1];
      if (!value) {
        throw new Error("Flag '--server' requires a server name.");
      }
      server = value;
      index += 1;
      continue;
    }
    if (token.startsWith('--server=')) {
      server = token.slice('--server='.length);
      if (!server) {
        throw new Error("Flag '--server' requires a server name.");
      }
      continue;
    }
    if (token.startsWith('-')) {
      throw new Error(`Unknown ${commandName} flag '${token}'.`);
    }
    remaining.push(token);
  }

  const sessionName = remaining[0];
  if (!sessionName) {
    throw new Error(`Usage: mcporter ${commandName} <session-name> [--server <name>] [-- <command-to-run>]`);
  }
  if (remaining.length > 1) {
    throw new Error(`Unexpected ${commandName} argument '${remaining[1]}'. Put commands after '--'.`);
  }
  return { sessionName, server, command };
}
