import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import {
  ensurePrivateRecordingDir,
  PRIVATE_RECORDING_FILE_MODE,
  resolveRecordingConfigPath,
  resolveRecordingPath,
} from '../runtime/record-transport.js';

export type RecordReplayMode = 'record' | 'replay';

export interface RecordReplayCommandArgs {
  readonly sessionName: string;
  readonly server?: string;
  readonly command: readonly string[];
}

export async function writeRecordReplayConfig(
  parsed: RecordReplayCommandArgs,
  mode: RecordReplayMode
): Promise<string> {
  const configPath = resolveRecordingConfigPath(parsed.sessionName);
  const recordingPath = resolveRecordingPath(parsed.sessionName);
  await ensurePrivateRecordingDir(configPath);
  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      {
        session: parsed.sessionName,
        server: parsed.server,
        mode,
        ...(mode === 'record' ? { recordPath: recordingPath } : { replayPath: recordingPath }),
        env: buildRecordReplayInstructionEnv(mode, parsed.sessionName, parsed.server),
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
  return configPath;
}

export function buildRecordReplayInstructions(
  mode: RecordReplayMode,
  sessionName: string,
  server: string | undefined
): string[] {
  return Object.entries(buildRecordReplayInstructionEnv(mode, sessionName, server)).map(
    ([key, value]) => `${key}=${value}`
  );
}

export async function runRecordReplayCommand(commandAndArgs: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
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

function buildRecordReplayInstructionEnv(
  mode: RecordReplayMode,
  sessionName: string,
  server: string | undefined
): Record<string, string> {
  const prefix = mode === 'record' ? 'MCPORTER_RECORD' : 'MCPORTER_REPLAY';
  return {
    [prefix]: sessionName,
    ...(server ? { [`${prefix}_SERVER`]: server } : {}),
    MCPORTER_DISABLE_KEEPALIVE: '*',
  };
}
