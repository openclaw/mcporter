import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveRecordingConfigPath, resolveRecordingPath } from '../runtime/record-transport.js';

export interface ParsedRecordArgs {
  readonly sessionName: string;
  readonly server?: string;
  readonly command: string[];
}

export async function handleRecordCli(args: string[]): Promise<void> {
  const parsed = parseRecordArgs(args);
  const recordPath = resolveRecordingPath(parsed.sessionName);

  if (parsed.command.length > 0) {
    await runWithRecordingEnv(parsed, {
      MCPORTER_RECORD: parsed.sessionName,
      MCPORTER_RECORD_SERVER: parsed.server,
    });
    return;
  }

  await writeModeConfig(parsed, {
    mode: 'record',
    recordPath,
    env: {
      MCPORTER_RECORD: parsed.sessionName,
      ...(parsed.server ? { MCPORTER_RECORD_SERVER: parsed.server } : {}),
    },
  });
  console.log(`Recording configuration written to ${resolveRecordingConfigPath(parsed.sessionName)}`);
  console.log(`Set MCPORTER_RECORD=${parsed.sessionName} before the next mcporter call to record ${recordPath}.`);
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

async function writeModeConfig(parsed: ParsedRecordArgs, extra: Record<string, unknown>): Promise<void> {
  const configPath = resolveRecordingConfigPath(parsed.sessionName);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      {
        session: parsed.sessionName,
        server: parsed.server,
        ...extra,
      },
      null,
      2
    )}\n`,
    'utf8'
  );
}

async function runWithRecordingEnv(parsed: ParsedRecordArgs, env: Record<string, string | undefined>): Promise<void> {
  const [command, ...commandArgs] = parsed.command;
  if (!command) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      stdio: 'inherit',
      env: {
        ...process.env,
        ...Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => Boolean(entry[1]))),
      },
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`Command '${command}' exited from signal ${signal}.`));
        return;
      }
      process.exitCode = code ?? 0;
      resolve();
    });
  });
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
