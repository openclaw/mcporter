import path from 'node:path';
import { CHROME_DEVTOOLS_RELAY_RUNTIME_ENV_KEYS } from '../../src/chrome-devtools-relay.js';

export function isolateChromeRelayTestEnvironment(home: string, env: NodeJS.ProcessEnv = process.env): () => void {
  // Snapshot every alias before deleting any: Windows env keys are case-insensitive.
  const original = CHROME_DEVTOOLS_RELAY_RUNTIME_ENV_KEYS.map((key) => [key, env[key]] as const);
  const preserved = new Set(['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_STATE_HOME']);
  for (const key of CHROME_DEVTOOLS_RELAY_RUNTIME_ENV_KEYS) {
    if (!preserved.has(key)) delete env[key];
  }
  env.HOME = home;
  env.USERPROFILE = home;
  // os.tmpdir() must stay inside the isolated home even without SystemRoot on Windows.
  env.TEMP = home;
  env.TMP = home;
  env.TMPDIR = home;

  return () => {
    for (const [key, value] of original) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  };
}

export function assertSyntheticRelayCredentialPath(
  file: string,
  directories: readonly string[],
  paths: typeof path = path
): void {
  if (paths.basename(file).toLowerCase() !== 'browser-extension-relay.secret') return;
  if (
    paths.isAbsolute(file) &&
    directories.some((directory) => {
      const relative = paths.relative(directory, file);
      return (
        relative !== '' && relative !== '..' && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative)
      );
    })
  ) {
    return;
  }
  throw Object.assign(new Error('No synthetic credential at this path'), { code: 'ENOENT' });
}
