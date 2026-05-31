const KEEP_ALIVE_DISABLED_FOR_MODE = '*';

export function buildRecordCommandEnv(sessionName: string, server: string | undefined): NodeJS.ProcessEnv {
  return buildModeEnv(
    {
      MCPORTER_RECORD: sessionName,
      MCPORTER_RECORD_SERVER: server,
      MCPORTER_DISABLE_KEEPALIVE: KEEP_ALIVE_DISABLED_FOR_MODE,
    },
    ['MCPORTER_REPLAY', 'MCPORTER_REPLAY_SERVER']
  );
}

export function buildReplayCommandEnv(sessionName: string, server: string | undefined): NodeJS.ProcessEnv {
  return buildModeEnv(
    {
      MCPORTER_REPLAY: sessionName,
      MCPORTER_REPLAY_SERVER: server,
      MCPORTER_DISABLE_KEEPALIVE: KEEP_ALIVE_DISABLED_FOR_MODE,
    },
    ['MCPORTER_RECORD', 'MCPORTER_RECORD_SERVER']
  );
}

export function isRecordReplayModeActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.MCPORTER_RECORD || env.MCPORTER_REPLAY);
}

export function isReplayModeActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(!env.MCPORTER_RECORD && env.MCPORTER_REPLAY);
}

function buildModeEnv(set: Record<string, string | undefined>, unset: readonly string[]): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of unset) {
    delete env[key];
  }
  for (const [key, value] of Object.entries(set)) {
    if (value) {
      env[key] = value;
    } else {
      delete env[key];
    }
  }
  return env;
}
