const AUTO_CONNECT_FLAGS = new Set(['--autoConnect', '--auto-connect']);
const NEGATED_AUTO_CONNECT_FLAGS = new Set(['--no-autoConnect', '--no-auto-connect']);
const NPX_VALUE_OPTIONS = new Set([
  '--cache',
  '--package',
  '--prefix',
  '--registry',
  '--userconfig',
  '--workspace',
  '-p',
  '-w',
]);
const NPX_COMMAND_STRING_OPTIONS = new Set(['--call', '-c']);
const NPX_NO_VALUE_OPTIONS = new Set(['--ignore-existing', '--no-install', '--quiet', '--silent', '--yes', '-y']);
const COMMON_WRAPPERS = new Set([
  'ash',
  'bash',
  'csh',
  'dash',
  'cmd',
  'doas',
  'env',
  'fish',
  'ksh',
  'mksh',
  'node',
  'npm',
  'npx',
  'bunx',
  'pnpm',
  'powershell',
  'pwsh',
  'sh',
  'sudo',
  'tcsh',
  'yarn',
  'zsh',
]);

export function isChromeDevtoolsToken(token: string): boolean {
  const normalized = token.replaceAll('\\', '/').toLowerCase();
  const basename = normalized.slice(normalized.lastIndexOf('/') + 1);
  return (
    /^chrome-devtools-mcp(?:@[^/]+)?(?:\.(?:bat|cjs|cmd|exe|js|mjs))?$/u.test(basename) ||
    (normalized.includes('/chrome-devtools-mcp/') && /\.(?:bat|cjs|cmd|exe|js|mjs)$/u.test(basename))
  );
}

export interface ChromeDevtoolsAutoConnectArgs {
  readonly enabled: boolean;
  readonly withoutAutoConnect: readonly string[];
}

export function isAmbiguousChromeDevtoolsAutoConnectCommand(command: string, args: readonly string[]): boolean {
  if (isChromeDevtoolsToken(command)) return false;
  if (isSupportedPackageLauncher(command)) {
    const target = findPackageLauncherTarget(args);
    if (!target) return false;
    if (target.ambiguous) return true;
    const nestedTarget = commandBasename(args[target.index] ?? '');
    return COMMON_WRAPPERS.has(nestedTarget) && containsChromeAutoConnectInvocation(args.slice(target.index + 1));
  }
  const launcher = commandBasename(command);
  if (COMMON_WRAPPERS.has(launcher)) return containsChromeAutoConnectInvocation(args);
  const scopedArgs = args.slice(0, optionTerminator(args));
  const tokenIndex = scopedArgs.findIndex(isChromeDevtoolsToken);
  return tokenIndex >= 0 && parseChromeDevtoolsAutoConnectArgs(scopedArgs.slice(tokenIndex + 1)).enabled;
}

/** Resolve target arguments for direct, npx, and bunx launch forms. */
export function resolveChromeDevtoolsAutoConnectCommand(
  command: string,
  args: readonly string[]
): ChromeDevtoolsAutoConnectArgs {
  const target = resolveChromeDevtoolsTarget(command, args);
  if (!target) return { enabled: false, withoutAutoConnect: args };
  const parsed = parseChromeDevtoolsAutoConnectArgs(target.args);
  return {
    enabled: parsed.enabled,
    withoutAutoConnect: [...target.prefix, ...parsed.withoutAutoConnect],
  };
}

/** Replace auto-connect options while preserving launcher args and target `--`. */
export function replaceChromeDevtoolsAutoConnectArgs(
  command: string,
  args: readonly string[],
  replacement: readonly string[]
): readonly string[] {
  const target = resolveChromeDevtoolsTarget(command, args);
  if (!target) return args;
  const parsed = parseChromeDevtoolsAutoConnectArgs(target.args);
  const targetArgs = [...parsed.withoutAutoConnect];
  targetArgs.splice(parsed.insertionIndex, 0, ...replacement);
  return [...target.prefix, ...targetArgs];
}

/** Mirrors the yargs boolean forms accepted by chrome-devtools-mcp. */
export function resolveChromeDevtoolsAutoConnectArgs(args: readonly string[]): ChromeDevtoolsAutoConnectArgs {
  const parsed = parseChromeDevtoolsAutoConnectArgs(args);
  return { enabled: parsed.enabled, withoutAutoConnect: parsed.withoutAutoConnect };
}

interface ChromeDevtoolsTarget {
  readonly prefix: readonly string[];
  readonly args: readonly string[];
}

function resolveChromeDevtoolsTarget(command: string, args: readonly string[]): ChromeDevtoolsTarget | undefined {
  if (isChromeDevtoolsToken(command)) return { prefix: [], args };
  if (!isSupportedPackageLauncher(command)) return undefined;

  const target = findPackageLauncherTarget(args);
  if (!target || target.ambiguous || !isChromeDevtoolsToken(args[target.index] ?? '')) return undefined;
  const separatorIndex = target.index + 1;
  const consumesSeparator = target.consumePostTargetSeparator && args[separatorIndex] === '--';
  const targetStart = consumesSeparator ? separatorIndex + 1 : separatorIndex;
  return { prefix: args.slice(0, targetStart), args: args.slice(targetStart) };
}

interface PackageLauncherTarget {
  readonly index: number;
  readonly ambiguous: boolean;
  readonly consumePostTargetSeparator: boolean;
}

function findPackageLauncherTarget(args: readonly string[]): PackageLauncherTarget | undefined {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === '--') {
      return index + 1 < args.length
        ? { index: index + 1, ambiguous: false, consumePostTargetSeparator: false }
        : undefined;
    }
    if (arg.startsWith('--call=')) {
      const value = arg.slice('--call='.length);
      return containsInlineChromeAutoConnect([value])
        ? { index, ambiguous: true, consumePostTargetSeparator: false }
        : undefined;
    }
    if (NPX_COMMAND_STRING_OPTIONS.has(arg)) {
      const value = args[index + 1] ?? '';
      return containsInlineChromeAutoConnect([value])
        ? { index: index + 1, ambiguous: true, consumePostTargetSeparator: false }
        : undefined;
    }
    if (NPX_VALUE_OPTIONS.has(arg)) {
      index += 1;
      continue;
    }
    if (NPX_NO_VALUE_OPTIONS.has(arg) || /^--[^=]+=.+/u.test(arg)) continue;
    if (arg.startsWith('-')) {
      return {
        index,
        ambiguous: containsChromeAutoConnectInvocation(args.slice(index)),
        consumePostTargetSeparator: false,
      };
    }
    return { index, ambiguous: false, consumePostTargetSeparator: true };
  }
  return undefined;
}

function isSupportedPackageLauncher(command: string): boolean {
  const launcher = commandBasename(command);
  return launcher === 'npx' || launcher === 'bunx';
}

function containsChromeAutoConnectInvocation(args: readonly string[]): boolean {
  const tokenIndex = args.findIndex(isChromeDevtoolsToken);
  if (tokenIndex >= 0) return parseChromeDevtoolsAutoConnectArgs(args.slice(tokenIndex + 1)).enabled;
  return containsInlineChromeAutoConnect(args);
}

function containsInlineChromeAutoConnect(args: readonly string[]): boolean {
  const rendered = args.join(' ').toLowerCase();
  return (
    rendered.includes('chrome-devtools-mcp') &&
    /--(?:auto-connect|autoconnect)(?:=true)?(?:[;'"&|)\]}]|\s|$)/u.test(rendered)
  );
}

function commandBasename(command: string): string {
  const normalized = command.replaceAll('\\', '/').toLowerCase();
  return normalized.slice(normalized.lastIndexOf('/') + 1).replace(/\.(?:cmd|exe)$/u, '');
}

function optionTerminator(args: readonly string[]): number {
  const index = args.indexOf('--');
  return index >= 0 ? index : args.length;
}

interface ParsedAutoConnectArgs extends ChromeDevtoolsAutoConnectArgs {
  readonly insertionIndex: number;
}

function parseChromeDevtoolsAutoConnectArgs(args: readonly string[]): ParsedAutoConnectArgs {
  const consumed = new Set<number>();
  let enabled = false;
  let sawOption = false;
  let terminatorIndex = args.length;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (arg === '--') {
      terminatorIndex = index;
      break;
    }
    if (NEGATED_AUTO_CONNECT_FLAGS.has(arg)) {
      sawOption = true;
      enabled = false;
      consumed.add(index);
      continue;
    }
    let matchedNegatedInline = false;
    for (const flag of NEGATED_AUTO_CONNECT_FLAGS) {
      if (!arg.startsWith(`${flag}=`)) continue;
      sawOption = true;
      enabled = false;
      consumed.add(index);
      matchedNegatedInline = true;
      break;
    }
    if (matchedNegatedInline) continue;
    if (AUTO_CONNECT_FLAGS.has(arg)) {
      sawOption = true;
      consumed.add(index);
      const pairedValue = booleanLiteral(args[index + 1]);
      if (pairedValue !== undefined) {
        enabled = pairedValue;
        consumed.add(index + 1);
        index += 1;
      } else {
        enabled = true;
      }
      continue;
    }
    for (const flag of AUTO_CONNECT_FLAGS) {
      if (!arg.startsWith(`${flag}=`)) continue;
      sawOption = true;
      enabled = arg.slice(flag.length + 1) === 'true';
      consumed.add(index);
      break;
    }
  }

  const withoutAutoConnect = args.filter((_arg, index) => !consumed.has(index));
  let insertionIndex = 0;
  for (let index = 0; index < terminatorIndex; index += 1) {
    if (!consumed.has(index)) insertionIndex += 1;
  }
  return { enabled: sawOption && enabled, withoutAutoConnect, insertionIndex };
}

// yargs 18 consumes only exact lowercase `true` and `false` after boolean options.
function booleanLiteral(value: string | undefined): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}
