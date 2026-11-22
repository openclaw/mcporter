export type HelpRow = readonly [flag: string, description: string];

export function helpFlagWidth(...sections: ReadonlyArray<readonly HelpRow[]>): number {
  return Math.max(...sections.flat().map(([flag]) => flag.length));
}

// Every description starts in the same column, two spaces past the longest flag.
export function formatHelpRows(rows: readonly HelpRow[], flagWidth = helpFlagWidth(rows)): string[] {
  return rows.map(([flag, description]) => `  ${flag.padEnd(flagWidth)}  ${description}`);
}
