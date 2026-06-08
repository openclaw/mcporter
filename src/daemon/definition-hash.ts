import { createHash } from 'node:crypto';
import type { ServerDefinition } from '../config.js';

export function hashDaemonDefinitions(definitions: readonly ServerDefinition[]): string {
  const sorted = definitions.toSorted((a, b) => a.name.localeCompare(b.name));
  return createHash('sha256').update(stableJsonStringify(sorted)).digest('hex').slice(0, 16);
}

function stableJsonStringify(value: unknown): string {
  const json = JSON.stringify(sortJsonValue(value));
  if (json === undefined) {
    throw new TypeError('Cannot serialize unsupported JSON root value.');
  }
  return json;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).toSorted()) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry !== undefined) {
      result[key] = sortJsonValue(entry);
    }
  }
  return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
