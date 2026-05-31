import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import {
  ensurePrivateRecordingDir,
  PRIVATE_RECORDING_FILE_MODE,
  resolveRecordingConfigPath,
  resolveRecordingPath,
} from '../runtime/record-transport.js';
import { parseReplayArgs } from './record-command.js';
import { buildReplayCommandEnv } from './record-replay-env.js';

export async function handleReplayCli(args: string[]): Promise<void> {
  const parsed = parseReplayArgs(args);
  const replayPath = resolveRecordingPath(parsed.sessionName);

  if (parsed.command.length > 0) {
    await runWithReplayEnv(parsed.command, buildReplayCommandEnv(parsed.sessionName, parsed.server));
    return;
  }

  const configPath = resolveRecordingConfigPath(parsed.sessionName);
  await ensurePrivateRecordingDir(configPath);
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
          MCPORTER_DISABLE_KEEPALIVE: '*',
        },
      },
      null,
      2
    )}\n`,
    {
      encoding: 'utf8',
      mode: PRIVATE_RECORDING_FILE_MODE,
    }
  );
  await fs.chmod(configPath, PRIVATE_RECORDING_FILE_MODE);
  console.log(`Replay configuration written to ${configPath}`);
  const envInstructions = [
    `MCPORTER_REPLAY=${parsed.sessionName}`,
    ...(parsed.server ? [`MCPORTER_REPLAY_SERVER=${parsed.server}`] : []),
    'MCPORTER_DISABLE_KEEPALIVE=*',
  ];
  console.log(`Set ${envInstructions.join(' and ')} before the next mcporter call to replay ${replayPath}.`);
}

export function printReplayHelp(): void {
  console.log(`Usage: mcporter replay <session-name> [--server <name>] [-- <command-to-run>]

Replay MCP JSON-RPC traffic from ~/.mcporter/recordings/<session-name>.ndjson.

Flags:
  --server <name>  Restrict replay to one configured server.`);
}

async function runWithReplayEnv(commandAndArgs: string[], env: NodeJS.ProcessEnv): Promise<void> {
  const [command, ...args] = commandAndArgs;
  if (!command) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      env,
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
