import { parsePositiveInteger } from '../timeouts.js';
import { CliUsageError } from '../errors.js';

export interface GeneratorCommonFlags {
  runtime?: 'node' | 'bun';
  timeout?: number;
  includeOptional?: boolean;
}

interface ExtractOptions {
  allowIncludeOptional?: boolean;
}

export function extractGeneratorFlags(args: string[], options: ExtractOptions = {}): GeneratorCommonFlags {
  const result: GeneratorCommonFlags = {};
  let index = 0;
  while (index < args.length) {
    const token = args[index];
    if (!token) {
      index += 1;
      continue;
    }
    if (token === '--runtime') {
      const value = args[index + 1];
      if (value !== 'node' && value !== 'bun') {
        throw new CliUsageError("--runtime must be 'node' or 'bun'.");
      }
      result.runtime = value;
      args.splice(index, 2);
      continue;
    }
    if (token === '--timeout') {
      const raw = args[index + 1];
      if (!raw) {
        throw new CliUsageError("Flag '--timeout' requires a value.");
      }
      const parsed = parsePositiveInteger(raw);
      if (parsed === undefined) {
        throw new CliUsageError('--timeout must be a positive integer.');
      }
      result.timeout = parsed;
      args.splice(index, 2);
      continue;
    }
    if (options.allowIncludeOptional && (token === '--include-optional' || token === '--all-parameters')) {
      result.includeOptional = true;
      args.splice(index, 1);
      continue;
    }
    index += 1;
  }
  return result;
}
