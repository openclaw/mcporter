import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveRecordingConfigPath, resolveRecordingPath } from '../runtime/record-transport.js';
import { parseReplayArgs } from './record-command.js';

export async function handleReplayCli(args: string[]): Promise<void> {
  const parsed = parseReplayArgs(args);
  const replayPath = resolveRecordingPath(parsed.sessionName);

  if (parsed.command.length > 0) {
    await runWithReplayEnv(parsed.command, {
      MCPORTER_REPLAY: parsed.sessionName,
      MCPORTER_REPLAY_SERVER: parsed.server,
    });
    return;
  }

  const configPath = resolveRecordingConfigPath(parsed.sessionName);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      {
        session: parsed.sessionName,
        server: parsed.server,
        mode: 'replay',
        replayPath,
        env: {
          MCPORTER_REPLAY: parsed.sessionName,
          ...(parsed.server ? { MCPORTER_REPLAY_SERVER: parsed.server } : {}),
        },
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  console.log(`Replay configuration written to ${configPath}`);
  console.log(`Set MCPORTER_REPLAY=${parsed.sessionName} before the next mcporter call to replay ${replayPath}.`);
}

export function printReplayHelp(): void {
  console.log(`Usage: mcporter replay <session-name> [--server <name>] [-- <command-to-run>]

Replay MCP JSON-RPC traffic from ~/.mcporter/recordings/<session-name>.ndjson.

Flags:
  --server <name>  Restrict replay to one configured server.`);
}

async function runWithReplayEnv(commandAndArgs: string[], env: Record<string, string | undefined>): Promise<void> {
  const [command, ...args] = commandAndArgs;
  if (!command) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
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
