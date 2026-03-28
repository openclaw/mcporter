import { describe, expect, it } from 'vitest';
import { createCallResult, describeConnectionIssue } from '../src/result-utils.js';

describe('result-utils connection helpers', () => {
  it('describes connection issues for offline errors', () => {
    const issue = describeConnectionIssue(new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:9999'));
    expect(issue.kind).toBe('offline');
  });
});

describe('createCallResult text extraction', () => {
  it('extracts text from content array at top level', () => {
    const response = {
      content: [
        {
          type: 'text',
          text: 'Hello World',
        },
      ],
    };
    const result = createCallResult(response);
    expect(result.text()).toBe('Hello World');
  });

  it('extracts text from content array nested inside raw wrapper', () => {
    const response = {
      raw: {
        content: [
          {
            type: 'text',
            text: 'Available pages for stanfordnlp/dspy:\n\n- 1 Overview',
          },
        ],
      },
    };
    const result = createCallResult(response);
    expect(result.text()).toBe('Available pages for stanfordnlp/dspy:\n\n- 1 Overview');
  });

  it('extracts multiple text entries and joins them', () => {
    const response = {
      content: [
        {
          type: 'text',
          text: 'First part',
        },
        {
          type: 'text',
          text: 'Second part',
        },
      ],
    };
    const result = createCallResult(response);
    expect(result.text()).toBe('First part\nSecond part');
  });

  it('returns null when no text content is available', () => {
    const response = {
      content: [
        {
          type: 'image',
          data: 'base64...',
        },
      ],
    };
    const result = createCallResult(response);
    expect(result.text()).toBe(null);
  });

  it('returns string when raw is already a string', () => {
    const response = 'Simple string response';
    const result = createCallResult(response);
    expect(result.text()).toBe('Simple string response');
  });
});

describe('createCallResult image extraction', () => {
  it('extracts image blocks from content', () => {
    const response = {
      content: [
        { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' },
        { type: 'image', mimeType: 'image/jpeg', data: 'd29ybGQ=' },
      ],
    };
    const result = createCallResult(response);
    expect(result.images()).toEqual([
      { mimeType: 'image/png', data: 'aGVsbG8=' },
      { mimeType: 'image/jpeg', data: 'd29ybGQ=' },
    ]);
  });

  it('extracts image blocks nested under raw.content', () => {
    const response = {
      raw: {
        content: [{ type: 'image', data: 'aGVsbG8=' }],
      },
    };
    const result = createCallResult(response);
    expect(result.images()).toEqual([{ mimeType: 'image/png', data: 'aGVsbG8=' }]);
  });

  it('returns null when no images exist', () => {
    const response = {
      content: [{ type: 'text', text: 'no image here' }],
    };
    const result = createCallResult(response);
    expect(result.images()).toBeNull();
  });
});

describe('createCallResult markdown extraction', () => {
  it('extracts markdown from content array', () => {
    const response = {
      content: [
        {
          type: 'markdown',
          text: '# Header\n\nContent',
        },
      ],
    };
    const result = createCallResult(response);
    expect(result.markdown()).toBe('# Header\n\nContent');
  });

  it('extracts markdown from content array nested inside raw wrapper', () => {
    const response = {
      raw: {
        content: [
          {
            type: 'markdown',
            text: '## Subtitle',
          },
        ],
      },
    };
    const result = createCallResult(response);
    expect(result.markdown()).toBe('## Subtitle');
  });

  it('extracts markdown from structuredContent nested inside raw wrapper', () => {
    const response = {
      raw: {
        structuredContent: {
          markdown: '_italic_',
        },
      },
    };
    const result = createCallResult(response);
    expect(result.markdown()).toBe('_italic_');
  });
});

describe('createCallResult json extraction', () => {
  it('returns null for text-only content', () => {
    const response = {
      content: [
        {
          type: 'text',
          text: 'Plain text',
        },
      ],
    };
    const result = createCallResult(response);
    expect(result.json()).toBe(null);
  });

  it('extracts json from content array with json type', () => {
    const response = {
      content: [
        {
          type: 'json',
          json: { foo: 'bar' },
        },
      ],
    };
    const result = createCallResult(response);
    expect(result.json()).toEqual({ foo: 'bar' });
  });

  it('returns all items when content array has multiple json entries', () => {
    const response = {
      content: [
        { type: 'json', json: { id: 1, name: 'first' } },
        { type: 'json', json: { id: 2, name: 'second' } },
        { type: 'json', json: { id: 3, name: 'third' } },
      ],
    };
    const result = createCallResult(response);
    expect(result.json()).toEqual([
      { id: 1, name: 'first' },
      { id: 2, name: 'second' },
      { id: 3, name: 'third' },
    ]);
  });

  it('returns all items when content has mixed json and text-parseable-as-json entries', () => {
    const response = {
      content: [
        { type: 'json', json: { source: 'json-type' } },
        { type: 'text', text: '{"source":"text-type"}' },
      ],
    };
    const result = createCallResult(response);
    expect(result.json()).toEqual([{ source: 'json-type' }, { source: 'text-type' }]);
  });

  it('extracts json from structuredContent nested inside raw wrapper', () => {
    const response = {
      raw: {
        structuredContent: {
          json: { nested: true },
        },
      },
    };
    const result = createCallResult(response);
    expect(result.json()).toEqual({ nested: true });
  });

  it('returns plain structuredContent objects even when they are not wrapped', () => {
    const response = {
      structuredContent: {
        status: 'ok',
        summary: 'No envelope keys here',
      },
    };
    const result = createCallResult(response);
    expect(result.json()).toEqual({
      status: 'ok',
      summary: 'No envelope keys here',
    });
  });

  it('returns the full structuredContent object when data is only one field among many', () => {
    const response = {
      raw: {
        structuredContent: {
          error: {
            type: 'USER_ERROR',
            message: 'Base name is required and cannot be empty or only whitespace',
            retryable: false,
            code: 'INVALID_NAME',
          },
          status: 'error',
          summary: 'Failed to create base: name is required',
          data: {},
          meta: {},
          trace_id: 'trace-123',
        },
      },
    };
    const result = createCallResult(response);
    expect(result.json()).toEqual({
      error: {
        type: 'USER_ERROR',
        message: 'Base name is required and cannot be empty or only whitespace',
        retryable: false,
        code: 'INVALID_NAME',
      },
      status: 'error',
      summary: 'Failed to create base: name is required',
      data: {},
      meta: {},
      trace_id: 'trace-123',
    });
  });

  it('returns the full parsed json object when text content includes data plus error fields', () => {
    const response = {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: {
              type: 'USER_ERROR',
              message: 'Base name is required and cannot be empty or only whitespace',
              retryable: false,
              code: 'INVALID_NAME',
            },
            status: 'error',
            summary: 'Failed to create base: name is required',
            data: {},
            meta: {},
            trace_id: 'trace-123',
          }),
        },
      ],
    };
    const result = createCallResult(response);
    expect(result.json()).toEqual({
      error: {
        type: 'USER_ERROR',
        message: 'Base name is required and cannot be empty or only whitespace',
        retryable: false,
        code: 'INVALID_NAME',
      },
      status: 'error',
      summary: 'Failed to create base: name is required',
      data: {},
      meta: {},
      trace_id: 'trace-123',
    });
  });
});

describe('createCallResult resource extraction', () => {
  it('extracts text from resource content blocks', () => {
    const response = {
      content: [
        {
          type: 'resource',
          resource: {
            uri: 'file:///repo/README.md',
            mimeType: 'text/markdown',
            text: '# My Project\n\nA description.',
          },
        },
      ],
    };
    const result = createCallResult(response);
    expect(result.text()).toBe('# My Project\n\nA description.');
  });

  it('treats markdown resources as markdown output too', () => {
    const response = {
      content: [
        {
          type: 'resource',
          resource: {
            uri: 'file:///repo/README.md',
            mimeType: 'text/markdown',
            text: '# My Project\n\nA description.',
          },
        },
      ],
    };
    const result = createCallResult(response);
    expect(result.markdown()).toBe('# My Project\n\nA description.');
  });

  it('creates placeholder for binary resource content blocks', () => {
    const response = {
      content: [
        {
          type: 'resource',
          resource: {
            uri: 'file:///repo/logo.png',
            mimeType: 'image/png',
            blob: 'aGVsbG8=',
          },
        },
      ],
    };
    const result = createCallResult(response);
    expect(result.text()).toBe('[Binary resource: file:///repo/logo.png]');
  });

  it('extracts text from mixed content blocks including resources', () => {
    const response = {
      content: [
        { type: 'text', text: 'Here is the file:' },
        {
          type: 'resource',
          resource: {
            uri: 'file:///repo/src/index.ts',
            mimeType: 'text/typescript',
            text: 'console.log("hello");',
          },
        },
      ],
    };
    const result = createCallResult(response);
    expect(result.text()).toBe('Here is the file:\nconsole.log("hello");');
  });

  it('parses JSON from resource text content', () => {
    const response = {
      content: [
        {
          type: 'resource',
          resource: {
            uri: 'file:///repo/config.json',
            mimeType: 'application/json',
            text: '{"key":"value"}',
          },
        },
      ],
    };
    const result = createCallResult(response);
    expect(result.json()).toEqual({ key: 'value' });
  });
});

describe('createCallResult structured accessors', () => {
  it('content() returns nested raw content array', () => {
    const nested = [{ type: 'text', text: 'Hello' }];
    const response = {
      raw: {
        content: nested,
      },
    };
    const result = createCallResult(response);
    expect(result.content()).toBe(nested);
  });

  it('structuredContent() returns nested raw structuredContent', () => {
    const structured = { text: 'Inner text' };
    const response = {
      raw: {
        structuredContent: structured,
      },
    };
    const result = createCallResult(response);
    expect(result.structuredContent()).toBe(structured);
  });

  it('text() falls back to structuredContent.text when no content exists', () => {
    const response = {
      raw: {
        structuredContent: {
          text: 'Structured fallback',
        },
      },
    };
    const result = createCallResult(response);
    expect(result.text()).toBe('Structured fallback');
  });
});
