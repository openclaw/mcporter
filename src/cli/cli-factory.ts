import { resolveConfigPath } from '../config/path-discovery.js';
import { parseLogLevel } from '../logging.js';
import { extractFlags } from './flag-utils.js';
import { getActiveLogger, getActiveLogLevel, logError, setLogLevel } from './logger-context.js';

export interface GlobalCliContext {
  readonly globalFlags: Record<string, string | undefined>;
  readonly oauthTimeoutOverride?: number;
  readonly runtimeOptions: {
    configPath?: string;
    rootDir?: string;
    logger: ReturnType<typeof getActiveLogger>;
    oauthTimeoutMs?: number;
  };
}

export function buildGlobalContext(argv: string[]): GlobalCliContext | { exit: true; code: number } {
  const globalFlags = extractFlags(argv, ['--config', '--root', '--log-level', '--oauth-timeout']);
  if (globalFlags['--log-level']) {
    try {
      const parsedLevel = parseLogLevel(globalFlags['--log-level'], getActiveLogLevel());
      setLogLevel(parsedLevel);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logError(message, error instanceof Error ? error : undefined);
      return { exit: true, code: 1 };
    }
  }

  let oauthTimeoutOverride: number | undefined;
  if (globalFlags['--oauth-timeout']) {
    const parsed = Number.parseInt(globalFlags['--oauth-timeout'], 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      logError("Flag '--oauth-timeout' must be a positive integer (milliseconds).");
      return { exit: true, code: 1 };
    }
    oauthTimeoutOverride = parsed;
  }

  const rootOverride = globalFlags['--root'];
  const configResolution = resolveConfigPath(globalFlags['--config'], rootOverride ?? process.cwd());

  const runtimeOptions = {
    configPath: configResolution.explicit ? configResolution.path : undefined,
    rootDir: rootOverride,
    logger: getActiveLogger(),
    oauthTimeoutMs: oauthTimeoutOverride,
  };

  return { globalFlags, oauthTimeoutOverride, runtimeOptions };
}
