import fs from 'node:fs';
import { inspect } from 'node:util';
import type { CallResult } from '../result-utils.js';
import { logWarn } from './logger-context.js';

export type OutputFormat = 'auto' | 'text' | 'markdown' | 'json' | 'raw';
const RAW_INSPECT_DEPTH = 8;

type RenderableKind = 'json' | 'markdown' | 'text' | 'raw';

interface RenderableOutput {
  kind: RenderableKind;
  value: unknown;
}

const PREFERRED_OUTPUT_BY_FORMAT: Record<OutputFormat, RenderableKind[]> = {
  auto: ['json', 'markdown', 'text', 'raw'],
  text: ['text', 'markdown', 'json', 'raw'],
  markdown: ['markdown', 'text', 'json', 'raw'],
  json: ['json', 'raw'],
  raw: ['raw'],
};

export function printCallOutput<T>(wrapped: CallResult<T>, raw: T, format: OutputFormat): void {
  const preferredKinds = PREFERRED_OUTPUT_BY_FORMAT[format];
  const renderable = resolveRenderableOutput(wrapped, raw, preferredKinds);
  emitRenderableOutput(renderable);
}

export function tailLogIfRequested(result: unknown, enabled: boolean): void {
  // Some transports still encode log paths inside tool results; tail when explicitly asked.
  if (!enabled) {
    return;
  }
  const candidates: string[] = [];
  if (typeof result === 'string') {
    const idx = result.indexOf(':');
    if (idx !== -1) {
      const candidate = result.slice(idx + 1).trim();
      if (candidate) {
        candidates.push(candidate);
      }
    }
  }
  if (result && typeof result === 'object') {
    const possibleKeys = ['logPath', 'logFile', 'logfile', 'path'];
    for (const key of possibleKeys) {
      const value = (result as Record<string, unknown>)[key];
      if (typeof value === 'string') {
        candidates.push(value);
      }
    }
  }

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) {
      logWarn(`Log path not found: ${candidate}`);
      continue;
    }
    try {
      const content = fs.readFileSync(candidate, 'utf8');
      const lines = content.trimEnd().split(/\r?\n/);
      const tail = lines.slice(-20);
      console.log(`--- tail ${candidate} ---`);
      for (const line of tail) {
        console.log(line);
      }
    } catch (error) {
      logWarn(`Failed to read log file ${candidate}: ${(error as Error).message}`);
    }
  }
}

function resolveRenderableOutput<T>(
  wrapped: CallResult<T>,
  raw: T,
  preferredKinds: RenderableKind[]
): RenderableOutput {
  for (const kind of preferredKinds) {
    if (kind === 'json') {
      const jsonValue = wrapped.json();
      if (jsonValue !== null) {
        return { kind, value: jsonValue };
      }
      continue;
    }
    if (kind === 'markdown') {
      const markdown = wrapped.markdown();
      if (typeof markdown === 'string') {
        return { kind, value: markdown };
      }
      continue;
    }
    if (kind === 'text') {
      const text = wrapped.text();
      if (typeof text === 'string') {
        return { kind, value: text };
      }
      continue;
    }
    if (kind === 'raw') {
      return { kind, value: raw };
    }
  }
  return { kind: 'raw', value: raw };
}

function emitRenderableOutput(renderable: RenderableOutput): void {
  if (renderable.kind === 'json') {
    if (!attemptPrintJson(renderable.value)) {
      printRaw(renderable.value);
    }
    return;
  }
  if (renderable.kind === 'markdown' || renderable.kind === 'text') {
    console.log(String(renderable.value));
    return;
  }
  printRaw(renderable.value);
}

function attemptPrintJson(value: unknown): boolean {
  if (value === undefined) {
    return false;
  }
  try {
    if (value === null) {
      console.log('null');
    } else {
      console.log(JSON.stringify(value, null, 2));
    }
    return true;
  } catch {
    return false;
  }
}

function printRaw(raw: unknown): void {
  if (typeof raw === 'string') {
    console.log(raw);
    return;
  }
  if (raw === null) {
    console.log('null');
    return;
  }
  if (raw === undefined) {
    console.log('undefined');
    return;
  }
  if (typeof raw === 'bigint') {
    console.log(raw.toString());
    return;
  }
  if (typeof raw === 'symbol' || typeof raw === 'function') {
    console.log(raw.toString());
    return;
  }
  // Keep nested payloads readable without unbounded inspect walks on huge objects.
  console.log(inspect(raw, { depth: RAW_INSPECT_DEPTH, maxStringLength: null, breakLength: 80 }));
}
