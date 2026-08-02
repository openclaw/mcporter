import { createHash } from 'node:crypto';
import type { ServerDefinition } from '../config.js';
import { stableJsonStringify } from '../stable-json.js';

export function hashDaemonDefinitions(definitions: readonly ServerDefinition[]): string {
  const sorted = definitions.toSorted((a, b) => a.name.localeCompare(b.name));
  return createHash('sha256').update(stableJsonStringify(sorted)).digest('hex').slice(0, 16);
}
