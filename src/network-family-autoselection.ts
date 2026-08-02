import net from 'node:net';

const NODE_DEFAULT_ATTEMPT_TIMEOUT_MS = 250;
const MCPORTER_ATTEMPT_TIMEOUT_MS = 1_500;
const NODE_OPTION = '--network-family-autoselection-attempt-timeout';

interface AutoSelectFamilyDefaults {
  getDefaultAutoSelectFamilyAttemptTimeout(): number;
  setDefaultAutoSelectFamilyAttemptTimeout(value: number): void;
}

export function configureAutoSelectFamilyAttemptTimeout(
  defaults: AutoSelectFamilyDefaults = net,
  nodeOptions = process.env.NODE_OPTIONS
): boolean {
  if (hasExplicitNodeOption(nodeOptions)) return false;
  if (defaults.getDefaultAutoSelectFamilyAttemptTimeout() !== NODE_DEFAULT_ATTEMPT_TIMEOUT_MS) return false;

  // Node's 250 ms Happy-Eyeballs attempt window is too short for otherwise reachable MCP endpoints on slower links.
  defaults.setDefaultAutoSelectFamilyAttemptTimeout(MCPORTER_ATTEMPT_TIMEOUT_MS);
  return true;
}

function hasExplicitNodeOption(nodeOptions: string | undefined): boolean {
  if (!nodeOptions) return false;
  return new RegExp(`(?:^|\\s)${NODE_OPTION}(?:=|\\s|$)`).test(nodeOptions);
}
