import type { EphemeralServerSpec } from './adhoc-server.js';
import { extractEphemeralServerFlags } from './ephemeral-flags.js';
import { consumeOutputFormat } from './output-format.js';
import { consumeTimeoutFlag } from './timeouts.js';

export type ListOutputFormat = 'text' | 'json';

export function extractListFlags(args: string[]): {
  schema: boolean;
  timeoutMs?: number;
  requiredOnly: boolean;
  ephemeral?: EphemeralServerSpec;
  format: ListOutputFormat;
  verbose: boolean;
  includeSources: boolean;
  brief: boolean;
} {
  let schema = false;
  let timeoutMs: number | undefined;
  let requiredOnly = true;
  let verbose = false;
  let includeSources = false;
  let brief = false;
  const format = consumeOutputFormat(args, {
    defaultFormat: 'text',
    allowed: ['text', 'json'],
    enableRawShortcut: false,
    jsonShortcutFlag: '--json',
  }) as ListOutputFormat;
  const ephemeral = extractEphemeralServerFlags(args);
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (token === '--schema') {
      schema = true;
      args.splice(index, 1);
      continue;
    }
    if (token === '--yes') {
      args.splice(index, 1);
      continue;
    }
    if (token === '--all-parameters') {
      requiredOnly = false;
      args.splice(index, 1);
      continue;
    }
    if (token === '--verbose') {
      verbose = true;
      args.splice(index, 1);
      continue;
    }
    if (token === '--sources') {
      includeSources = true;
      args.splice(index, 1);
      continue;
    }
    if (token === '--brief' || token === '--signatures') {
      brief = true;
      args.splice(index, 1);
      continue;
    }
    if (token === '--timeout') {
      timeoutMs = consumeTimeoutFlag(args, index, { flagName: '--timeout' });
      continue;
    }
    index += 1;
  }
  if (brief) {
    const conflicts: string[] = [];
    if (format === 'json') {
      conflicts.push('--json');
    }
    if (schema) {
      conflicts.push('--schema');
    }
    if (verbose) {
      conflicts.push('--verbose');
    }
    if (!requiredOnly) {
      conflicts.push('--all-parameters');
    }
    if (conflicts.length > 0) {
      throw new Error(`--brief cannot be used with ${conflicts.join(', ')}`);
    }
  }
  return { schema, timeoutMs, requiredOnly, ephemeral, format, verbose, includeSources, brief };
}
