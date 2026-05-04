import type { Runtime } from '../runtime.js';
import {
  type EphemeralServerResolution,
  type EphemeralServerSpec,
  persistEphemeralServer,
  resolveEphemeralServer,
  splitCommandLine,
} from './adhoc-server.js';
import { looksLikeHttpUrl, normalizeHttpUrlCandidate } from './http-utils.js';
import { findServerByHttpUrl } from './server-lookup.js';

interface PrepareEphemeralServerTargetOptions {
  runtime: Runtime;
  target?: string;
  ephemeral?: EphemeralServerSpec;
  nameHints?: string[];
  reuseFromSpec?: boolean;
}

export interface PrepareEphemeralServerTargetResult {
  target?: string;
  resolution?: EphemeralServerResolution;
  persistPath?: string;
}

export async function prepareEphemeralServerTarget(
  options: PrepareEphemeralServerTargetOptions
): Promise<PrepareEphemeralServerTargetResult> {
  let target = options.target;
  let spec = options.ephemeral ? { ...options.ephemeral } : undefined;

  const promoteUrlCandidate = (value: string | undefined): string | undefined => {
    if (!value) {
      return value;
    }
    const normalized = normalizeHttpUrlCandidate(value);
    if (!normalized) {
      return value;
    }
    const reused = findServerByHttpUrl(options.runtime.getDefinitions(), normalized);
    if (reused) {
      return reused;
    }
    if (!spec) {
      spec = { httpUrl: normalized };
    } else if (!spec.httpUrl) {
      spec = { ...spec, httpUrl: normalized };
    }
    return undefined;
  };

  target = promoteUrlCandidate(target);

  if (!spec) {
    const inferredInline = inferInlineStdioSpec(target);
    if (inferredInline) {
      spec = inferredInline;
      target = undefined;
    }
  }

  if (spec) {
    applyNameHints(spec, options.nameHints);
  }

  if (!spec) {
    return { target };
  }

  if (spec.httpUrl) {
    const normalized = normalizeHttpUrlCandidate(spec.httpUrl);
    if (normalized) {
      spec = { ...spec, httpUrl: normalized };
      if (options.reuseFromSpec) {
        const reused = findServerByHttpUrl(options.runtime.getDefinitions(), normalized);
        if (reused) {
          return { target: reused };
        }
      }
    }
  }

  const resolution = resolveEphemeralServer(spec);
  options.runtime.registerDefinition(resolution.definition, { overwrite: true });
  if (spec.persistPath) {
    await persistEphemeralServer(resolution, spec.persistPath);
  }
  const resolvedTarget = target ?? resolution.name;
  return { target: resolvedTarget, resolution, persistPath: spec.persistPath };
}

export async function persistPreparedEphemeralServer(
  runtime: Runtime,
  prepared: PrepareEphemeralServerTargetResult | undefined
): Promise<void> {
  if (!prepared?.resolution || !prepared.persistPath) {
    return;
  }
  let currentDefinition;
  try {
    currentDefinition = runtime.getDefinition(prepared.resolution.name);
  } catch {
    return;
  }
  const persistedEntry = { ...prepared.resolution.persistedEntry };
  if (currentDefinition.auth === 'oauth') {
    persistedEntry.auth = 'oauth';
  }
  await persistEphemeralServer(
    {
      ...prepared.resolution,
      persistedEntry,
    },
    prepared.persistPath
  );
}

function applyNameHints(spec: EphemeralServerSpec | undefined, hints: string[] | undefined): void {
  if (!spec || spec.name || !hints) {
    return;
  }
  for (const hint of hints) {
    if (!hint) {
      continue;
    }
    if (looksLikeHttpUrl(hint)) {
      continue;
    }
    spec.name = hint;
    break;
  }
}

function inferInlineStdioSpec(target: string | undefined): EphemeralServerSpec | undefined {
  if (!target) {
    return undefined;
  }
  const trimmed = target.trim();
  if (!trimmed) {
    return undefined;
  }
  if (looksLikeHttpUrl(trimmed)) {
    return undefined;
  }
  if (!trimmed.includes(' ')) {
    return undefined;
  }
  try {
    const parts = splitCommandLine(trimmed);
    if (parts.length < 2) {
      return undefined;
    }
    const executable = parts[0]?.split(/[\\/]/).pop();
    if (executable !== 'npx') {
      return undefined;
    }
    return { stdioCommand: trimmed };
  } catch {
    return undefined;
  }
}
