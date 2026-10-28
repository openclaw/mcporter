import type { ParseError } from 'jsonc-parser';
import { parse as parseJsonWithComments, printParseErrorCode } from 'jsonc-parser';

export function parseJsonBuffer(buffer: string): unknown {
  const errors: ParseError[] = [];
  const parsed = parseJsonWithComments(buffer.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true });
  const first = errors[0];
  if (first) {
    const message = printParseErrorCode(first.error);
    throw new SyntaxError(`Failed to parse JSON (offset ${first.offset}): ${message}`);
  }
  return parsed;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
