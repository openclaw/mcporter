import fs from 'node:fs';
import { inspect } from 'node:util';
import type { CallResult } from '../result-utils.js';
import { logWarn } from './logger-context.js';

export type OutputFormat = 'auto' | 'text' | 'markdown' | 'json' | 'raw';

export function printCallOutput<T>(wrapped: CallResult<T>, raw: T, format: OutputFormat): void {
  switch (format) {
    case 'raw': {
      printRaw(raw);
      return;
    }
    case 'json': {
      const jsonValue = wrapped.json();
      if (jsonValue !== null && attemptPrintJson(jsonValue)) {
        return;
      }
      printRaw(raw);
      return;
    }
    case 'markdown': {
      const markdown = wrapped.markdown();
      if (typeof markdown === 'string') {
        console.log(markdown);
        return;
      }
      const text = wrapped.text();
      if (typeof text === 'string') {
        console.log(text);
        return;
      }
      const jsonValue = wrapped.json();
      if (jsonValue !== null && attemptPrintJson(jsonValue)) {
        return;
      }
      printRaw(raw);
      return;
    }
    case 'text': {
      const text = wrapped.text();
      if (typeof text === 'string') {
        console.log(text);
        return;
      }
      const markdown = wrapped.markdown();
      if (typeof markdown === 'string') {
        console.log(markdown);
        return;
      }
      const jsonValue = wrapped.json();
      if (jsonValue !== null && attemptPrintJson(jsonValue)) {
        return;
      }
      printRaw(raw);
      return;
    }
    default: {
      const jsonValue = wrapped.json();
      if (jsonValue !== null && attemptPrintJson(jsonValue)) {
        return;
      }
      const markdown = wrapped.markdown();
      if (typeof markdown === 'string') {
        console.log(markdown);
        return;
      }
      const text = wrapped.text();
      if (typeof text === 'string') {
        console.log(text);
        return;
      }
      printRaw(raw);
    }
  }
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
  console.log(inspect(raw, { depth: null, maxStringLength: null, breakLength: 80 }));
}
