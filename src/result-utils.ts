import { analyzeConnectionError, type ConnectionIssue } from './error-classifier.js';

export interface ImageContent {
  data: string;
  mimeType: string;
}

export interface CallResult<T = unknown> {
  raw: T;
  text(joiner?: string): string | null;
  markdown(joiner?: string): string | null;
  json<J = unknown>(): J | null;
  images(): ImageContent[] | null;
  content(): unknown[] | null;
  structuredContent(): unknown;
}

interface ExtractedEnvelope {
  content: unknown[] | null;
  structuredContent: unknown;
}

interface CollectedCallContent {
  content: unknown[] | null;
  structuredContent: unknown;
  textEntries: string[];
  markdownEntries: string[];
  jsonCandidates: unknown[];
  images: ImageContent[];
}

function extractEnvelope(raw: unknown): ExtractedEnvelope {
  if (!raw || typeof raw !== 'object') {
    return { content: null, structuredContent: null };
  }

  const obj = raw as Record<string, unknown>;
  let content: unknown[] | null = null;
  let structuredContent: unknown = null;

  if ('content' in obj && Array.isArray(obj.content)) {
    content = obj.content as unknown[];
  }
  if ('structuredContent' in obj) {
    structuredContent = obj.structuredContent;
  }

  if ('raw' in obj && obj.raw && typeof obj.raw === 'object') {
    const nested = obj.raw as Record<string, unknown>;
    if (!content && 'content' in nested && Array.isArray(nested.content)) {
      content = nested.content as unknown[];
    }
    if (structuredContent === null && 'structuredContent' in nested) {
      structuredContent = nested.structuredContent;
    }
  }

  return { content, structuredContent };
}

// asString converts known content/value shapes into plain strings.
function asString(value: unknown): string | null {
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object' && 'text' in value) {
    const text = (value as Record<string, unknown>).text;
    return typeof text === 'string' ? text : null;
  }
  return null;
}

function collectCallContent(raw: unknown): CollectedCallContent {
  const envelope = extractEnvelope(raw);
  const textEntries: string[] = [];
  const markdownEntries: string[] = [];
  const jsonCandidates: unknown[] = [];
  const images: ImageContent[] = [];
  const rawContents =
    raw && typeof raw === 'object' && Array.isArray((raw as { contents?: unknown }).contents)
      ? ((raw as { contents: unknown[] }).contents ?? [])
      : undefined;
  if (rawContents) {
    for (const resource of rawContents) {
      collectResourcePayload(resource, textEntries, markdownEntries, jsonCandidates);
    }
  }

  if (!envelope.content) {
    return {
      content: envelope.content,
      structuredContent: envelope.structuredContent,
      textEntries,
      markdownEntries,
      jsonCandidates,
      images,
    };
  }

  for (const entry of envelope.content) {
    if (typeof entry === 'string') {
      const parsed = tryParseJson(entry);
      if (parsed !== null) {
        jsonCandidates.push(parsed);
      }
      continue;
    }
    if (!entry || typeof entry !== 'object' || !('type' in entry)) {
      continue;
    }

    const typedEntry = entry as Record<string, unknown>;
    if (typedEntry.type === 'json') {
      const parsed = tryParseJson(entry);
      if (parsed !== null) {
        jsonCandidates.push(parsed);
      }
      continue;
    }
    if (typedEntry.type === 'image') {
      const data = typedEntry.data;
      const mimeType = typedEntry.mimeType ?? 'image/png';
      if (typeof data === 'string' && typeof mimeType === 'string') {
        images.push({ data, mimeType });
      }
      continue;
    }
    if (typedEntry.type === 'resource') {
      const resource = typedEntry.resource as Record<string, unknown> | undefined;
      collectResourcePayload(resource, textEntries, markdownEntries, jsonCandidates);
      continue;
    }
    if (typedEntry.type !== 'text' && typedEntry.type !== 'markdown') {
      continue;
    }

    const text = asString(entry);
    if (!text) {
      continue;
    }
    textEntries.push(text);
    if (typedEntry.type === 'markdown') {
      markdownEntries.push(text);
    }
    const parsed = tryParseJson(text);
    if (parsed !== null) {
      jsonCandidates.push(parsed);
    }
  }

  return {
    content: envelope.content,
    structuredContent: envelope.structuredContent,
    textEntries,
    markdownEntries,
    jsonCandidates,
    images,
  };
}

function collectResourcePayload(
  resource: unknown,
  textEntries: string[],
  markdownEntries: string[],
  jsonCandidates: unknown[]
): void {
  if (!resource || typeof resource !== 'object') {
    return;
  }
  const record = resource as Record<string, unknown>;
  const uri = typeof record.uri === 'string' ? record.uri : '';
  const mimeType = typeof record.mimeType === 'string' ? record.mimeType : '';
  if (typeof record.text === 'string') {
    textEntries.push(record.text);
    if (mimeType.toLowerCase().includes('markdown')) {
      markdownEntries.push(record.text);
    }
    const parsed = tryParseJson(record.text);
    if (parsed !== null) {
      jsonCandidates.push(parsed);
    }
  } else if (typeof record.blob === 'string') {
    textEntries.push(`[Binary resource: ${uri}]`);
  }
}

function collectText(entries: string[], joiner: string): string | null {
  if (entries.length === 0) {
    return null;
  }
  return entries.join(joiner);
}

function collectImages(images: ImageContent[]): ImageContent[] | null {
  if (images.length === 0) {
    return null;
  }
  return images;
}

function unwrapJsonEnvelope(record: Record<string, unknown>, fallback: unknown): unknown {
  if ('json' in record) {
    return record.json ?? null;
  }
  if ('data' in record) {
    return Object.keys(record).length === 1 ? (record.data ?? null) : fallback;
  }
  return null;
}

function parseStructuredContent(value: unknown): unknown {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'string') {
    return tryParseJson(value);
  }
  if (typeof value !== 'object') {
    return null;
  }

  const unwrapped = unwrapJsonEnvelope(value as Record<string, unknown>, value);
  return unwrapped ?? value;
}

// tryParseJson pulls JSON payloads out of structured responses or raw strings.
function tryParseJson(value: unknown): unknown {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === 'object') {
    const unwrapped = unwrapJsonEnvelope(value as Record<string, unknown>, value);
    if (unwrapped !== null) {
      return unwrapped;
    }
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return null;
}

// createCallResult wraps a tool response with helpers for common content types.
export function createCallResult<T = unknown>(raw: T): CallResult<T> {
  let cachedContent: CollectedCallContent | undefined;
  const getCollectedContent = (): CollectedCallContent => {
    if (cachedContent) {
      return cachedContent;
    }
    cachedContent = collectCallContent(raw);
    return cachedContent;
  };

  return {
    raw,
    text(joiner = '\n') {
      if (raw == null) {
        return null;
      }
      if (typeof raw === 'string') {
        return raw;
      }

      const collected = getCollectedContent();
      const combinedText = collectText(collected.textEntries, joiner);
      if (combinedText) {
        return combinedText;
      }
      return asString(collected.structuredContent);
    },
    markdown(joiner = '\n') {
      const collected = getCollectedContent();
      const structured = collected.structuredContent;
      if (structured && typeof structured === 'object') {
        const markdown = (structured as Record<string, unknown>).markdown;
        if (typeof markdown === 'string') {
          return markdown;
        }
      }
      return collectText(collected.markdownEntries, joiner);
    },
    json<J = unknown>() {
      const collected = getCollectedContent();
      const parsedStructured = parseStructuredContent(collected.structuredContent);
      if (parsedStructured !== null) {
        return parsedStructured as J;
      }
      if (collected.jsonCandidates.length === 1) {
        return collected.jsonCandidates[0] as J;
      }
      if (collected.jsonCandidates.length > 1) {
        return collected.jsonCandidates as J;
      }
      if (typeof raw === 'string') {
        const parsedRaw = tryParseJson(raw);
        if (parsedRaw !== null) {
          return parsedRaw as J;
        }
      }
      const textContent = this.text?.();
      if (typeof textContent === 'string') {
        const parsedText = tryParseJson(textContent);
        if (parsedText !== null) {
          return parsedText as J;
        }
      }
      const markdownContent = this.markdown?.();
      if (typeof markdownContent === 'string') {
        const parsedMarkdown = tryParseJson(markdownContent);
        if (parsedMarkdown !== null) {
          return parsedMarkdown as J;
        }
      }
      return null;
    },
    images() {
      const collected = getCollectedContent();
      return collectImages(collected.images);
    },
    content() {
      return getCollectedContent().content;
    },
    structuredContent() {
      return getCollectedContent().structuredContent;
    },
  };
}

export type { ConnectionIssue } from './error-classifier.js';

export function describeConnectionIssue(error: unknown): ConnectionIssue {
  return analyzeConnectionError(error);
}

export function wrapCallResult<T = unknown>(raw: T): { raw: T; callResult: CallResult<T> } {
  return { raw, callResult: createCallResult(raw) };
}
