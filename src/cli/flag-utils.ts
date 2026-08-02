export type FlagMap = Partial<Record<string, string>>;

// extractFlags snacks out targeted flags (and their values) from argv in place.
export function extractFlags(args: string[], keys: readonly string[]): FlagMap {
  const flags: FlagMap = {};
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === '--') {
      break;
    }
    if (token === undefined || !keys.includes(token)) {
      index += 1;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined) {
      throw new Error(`Flag '${token}' requires a value.`);
    }
    flags[token] = value;
    args.splice(index, 2);
  }
  return flags;
}

// expectValue asserts that a flag is followed by a value.
export function expectValue(flag: string, value: string | undefined): string {
  if (value === undefined) {
    throw new Error(`Flag '${flag}' requires a value.`);
  }
  return value;
}

export function consumeMatchingTokens(args: string[], predicate: (token: string) => boolean): boolean {
  let found = false;
  for (let index = args.length - 1; index >= 0; index -= 1) {
    const token = args[index];
    if (token && predicate(token)) {
      args.splice(index, 1);
      found = true;
    }
  }
  return found;
}
