const TRUE_VALUES = new Set(['1', 'true', 'yes']);

export function suppressBrowserLaunchFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.MCPORTER_OAUTH_NO_BROWSER;
  return raw !== undefined && TRUE_VALUES.has(raw.trim().toLowerCase());
}
