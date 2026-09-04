import { z } from 'zod';
import { RawEntrySchema, type ServerDefinition } from '../config-schema.js';
import type { ResolvedServerDefinition } from './connection-identity.js';

const command = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('stdio'),
      command: z.string().min(1),
      args: z.array(z.string()).max(1024),
      cwd: z.string().min(1),
    })
    .strict(),
  z
    .object({ kind: z.literal('http'), url: z.string().url(), headers: z.record(z.string(), z.string()).optional() })
    .strict(),
]);
const definition = z
  .object({
    ...RawEntrySchema.shape,
    name: z.string().min(1).max(256),
    configuredEnv: z.record(z.string(), z.string()).optional(),
    launchCommand: z.string().min(1).optional(),
    command,
    lifecycle: z
      .object({ mode: z.enum(['keep-alive', 'ephemeral']), idleTimeoutMs: z.number().positive().optional() })
      .optional(),
    source: z.unknown().optional(),
    sources: z.unknown().optional(),
  })
  .strip();
const registration = z
  .object({
    definitions: z.array(definition).max(256),
    clientInfo: z.object({ name: z.string().min(1).max(256), version: z.string().min(1).max(256) }).optional(),
  })
  .strict();

export function decodeView(value: unknown): {
  definitions: ResolvedServerDefinition[];
  clientInfo?: { name: string; version: string };
} {
  const parsed = registration.parse(value);
  const names = new Set<string>();
  const definitions = parsed.definitions.map((entry) => {
    if (names.has(entry.name)) throw new Error('Duplicate view alias.');
    names.add(entry.name);
    if (entry.allowedTools && entry.blockedTools) throw new Error('Conflicting tool filters.');
    const { source: _source, sources: _sources, ...rest } = entry;
    const decodedCommand =
      entry.command.kind === 'http'
        ? { kind: 'http' as const, url: new URL(entry.command.url), headers: entry.command.headers }
        : entry.command;
    return Object.assign(rest, { command: decodedCommand }) as ServerDefinition;
  });
  return { definitions, clientInfo: parsed.clientInfo };
}
