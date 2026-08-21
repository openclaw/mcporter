import { splitCommandLine } from '../adhoc-server.js';
import { toAsciiSlug } from '../ascii-slug.js';
import { normalizeHttpUrlCandidate } from '../http-utils.js';
import type { CommandInput } from './types.js';

export function inferNameFromCommand(command: CommandInput): string | undefined {
  if (typeof command === 'string') {
    const normalizedHttp = normalizeHttpUrlCandidate(command);
    if (normalizedHttp) {
      try {
        const url = new URL(normalizedHttp);
        const segments = url.hostname.split('.').filter(Boolean);
        for (const segment of segments) {
          const lowered = segment.toLowerCase();
          if (lowered === 'www' || lowered === 'api' || lowered === 'mcp') {
            continue;
          }
          const slug = slugify(segment);
          if (slug) {
            return slug;
          }
        }
        const fallback = slugify(segments[0] ?? url.hostname);
        if (fallback) {
          return fallback;
        }
        const derived = deriveNameFromUrl(url);
        const derivedSlug = derived ? slugify(derived) : undefined;
        if (derivedSlug) {
          return derivedSlug;
        }
      } catch {
        // ignore invalid URL; fall through to token logic
      }
    }
    const trimmed = command.trim();
    if (looksLikeInlineCommand(trimmed)) {
      try {
        const parsed = parseInlineCommand(trimmed);
        const derived = inferNameFromCommand(parsed);
        if (derived) {
          return derived;
        }
      } catch {
        // unable to parse; fall through to token heuristic
      }
    }
    const firstToken = trimmed.split(/\s+/)[0] ?? trimmed;
    const candidateToken = firstToken.split(/[\\/]/).pop() ?? firstToken;
    return slugify(candidateToken.replace(/\.[a-z0-9]+$/i, ''));
  }
  const parts = [command.command, ...(command.args ?? [])];
  if (parts.length === 0) {
    return undefined;
  }
  const script = parts.find((part) => /\.[cm]?(ts|js)x?$/i.test(part));
  if (script) {
    return slugify(stripExtension(basename(script)));
  }
  const packageArg = parts.find((_part, index) => index > 0 && /[@/]/.test(_part));
  if (packageArg) {
    return slugify(packageArg.replace(/^@/, '').split('@')[0] ?? packageArg);
  }
  const bareArg = findLastPositionalArg(parts);
  if (bareArg) {
    return slugify(bareArg);
  }
  return slugify(basename(parts[0] ?? 'command'));
}

export function normalizeCommandInput(value: string): CommandInput {
  const httpCandidate = normalizeHttpUrlCandidate(value);
  if (httpCandidate) {
    return httpCandidate;
  }
  if (looksLikeInlineCommand(value)) {
    return parseInlineCommand(value);
  }
  return { command: value };
}

export function looksLikeInlineCommand(value: string): boolean {
  if (!value) {
    return false;
  }
  if (!/\s/.test(value)) {
    return false;
  }
  try {
    const parts = splitCommandLine(value.trim());
    return parts.length > 0;
  } catch {
    return false;
  }
}

export function parseInlineCommand(value: string): CommandInput {
  const parts = splitCommandLine(value.trim());
  if (parts.length === 0) {
    throw new Error('--command requires a non-empty value.');
  }
  const [command, ...rest] = parts as [string, ...string[]];
  return { command, args: rest };
}

function slugify(value: string): string | undefined {
  const normalized = toAsciiSlug(value);
  return normalized || undefined;
}

function basename(value: string): string {
  const segments = value.split(/[\\/]/);
  return segments[segments.length - 1] ?? value;
}

function stripExtension(value: string): string {
  const index = value.lastIndexOf('.');
  if (index === -1) {
    return value;
  }
  return value.slice(0, index);
}

function findLastPositionalArg(parts: string[]): string | undefined {
  for (let index = parts.length - 1; index >= 1; index -= 1) {
    const part = parts[index];
    if (!part) {
      continue;
    }
    if (part.startsWith('-')) {
      continue;
    }
    if (/^[A-Za-z0-9_]+=/.test(part)) {
      continue;
    }
    if (part.includes('://')) {
      continue;
    }
    return part;
  }
  return undefined;
}

function deriveNameFromUrl(url: URL): string | undefined {
  const genericHosts = new Set(['www', 'api', 'mcp', 'service', 'services', 'app', 'localhost']);
  const knownTlds = new Set(['com', 'net', 'org', 'io', 'ai', 'app', 'dev', 'co', 'cloud']);
  const parts = url.hostname.split('.').filter(Boolean);
  const filtered = parts.filter((part) => {
    const lower = part.toLowerCase();
    if (genericHosts.has(lower)) {
      return false;
    }
    if (knownTlds.has(lower)) {
      return false;
    }
    if (/^\d+$/.test(part)) {
      return false;
    }
    return true;
  });
  if (filtered.length > 0) {
    const last = filtered[filtered.length - 1];
    if (last) {
      return last;
    }
  }
  const firstSegment = url.pathname.split('/').find(Boolean);
  if (firstSegment) {
    return firstSegment.replace(/[^a-zA-Z0-9-_]/g, '-');
  }
  return undefined;
}
