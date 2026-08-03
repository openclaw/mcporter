import fs from 'node:fs/promises';

export async function ensureDistBuilt(cliEntry: string): Promise<void> {
  try {
    await fs.access(cliEntry);
  } catch {
    throw new Error('dist/cli.js is missing; run `pnpm build` before invoking this integration test directly.');
  }
}
