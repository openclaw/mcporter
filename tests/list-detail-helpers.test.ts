import { describe, expect, it } from 'vitest';
import type { GeneratedOption } from '../src/cli/generate/tools.js';
import { buildToolDoc, selectDisplayOptions } from '../src/cli/list-detail-helpers.js';
import { buildDocComment, wrapCommentText } from '../src/cli/list-doc-comments.js';
import {
  formatCallExpressionExample,
  formatExampleBlock,
  formatFlagUsage,
  formatFunctionSignature,
  formatOptionalSummary,
} from '../src/cli/list-signature.js';

const baseOption = (overrides: Partial<GeneratedOption> = {}): GeneratedOption => ({
  property: 'field',
  cliName: 'field',
  description: 'desc',
  required: true,
  type: 'string',
  placeholder: '<field>',
  ...overrides,
});

describe('wrapCommentText', () => {
  it('wraps long sentences across multiple lines', () => {
    const text = 'This is a very long sentence designed to exceed the width limit and therefore wrap neatly.';
    const lines = wrapCommentText(text, 40);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toBe(text.trim());
    expect(lines.every((line) => line.length <= 40)).toBe(true);
  });
});

describe('selectDisplayOptions', () => {
  it('always shows at least five parameters even when optional', () => {
    const options = Array.from({ length: 6 }, (_, index) => baseOption({ property: `opt${index}`, required: false }));
    const { displayOptions, hiddenOptions } = selectDisplayOptions(options, true, 5);
    expect(displayOptions).toHaveLength(5);
    expect(hiddenOptions).toHaveLength(1);
  });
});

describe('buildDocComment', () => {
  it('inserts a blank line between description and parameter docs and wraps content', () => {
    const options = [
      baseOption({
        property: 'teamId',
        description:
          'The team ID to get the deployment events for. Alternatively the team slug can be used. Team IDs start with "team_". If you do not know the team ID or slug, it can be found through these mechanism: Read the file .vercel/project.json, Use the list_teams tool',
      }),
    ];
    const lines = buildDocComment('List Vercel projects with lots of details.', options);
    expect(lines).toBeDefined();
    const printable = (lines ?? []).map(stripAnsi);
    const separatorIndex = printable.findIndex((line) => line.trim() === '*');
    expect(separatorIndex).toBeGreaterThan(0);
    const paramLine = printable.find((line) => line.includes('@param teamId'));
    expect(paramLine).toBeDefined();
    const continuationLine = printable.find((line) => line.includes('Team IDs start with'));
    expect(continuationLine).toBeDefined();
  });
});

describe('formatOptionalSummary', () => {
  it('shows at most five names and appends ellipsis for the rest', () => {
    const hidden = Array.from({ length: 7 }, (_, index) => baseOption({ property: `param${index}` }));
    const summary = stripAnsi(formatOptionalSummary(hidden));
    expect(summary).toContain('optional (7)');
    expect(summary).toContain('param0');
    expect(summary.trim().endsWith('...')).toBe(true);
  });
});

describe('formatFlagUsage', () => {
  it('renders required, optional, and extra flags consistently', () => {
    const options = [
      baseOption({ property: 'title', cliName: 'title', required: true, placeholder: '<title>' }),
      baseOption({ property: 'body', cliName: 'body', required: false, placeholder: '<body>' }),
    ];
    const usage = formatFlagUsage(options, [{ text: '--raw <json>' }], { colorize: false });
    expect(usage).toBe('--title <title> [--body <body>] [--raw <json>]');
  });
});

describe('formatFunctionSignature', () => {
  it('renders uncolored TypeScript-style signatures when colorize is false', () => {
    const signature = formatFunctionSignature(
      'create_comment',
      [
        baseOption({ property: 'issueId', description: 'Issue identifier', required: true }),
        baseOption({ property: 'parentId', required: false, description: 'Optional parent' }),
      ],
      { title: 'Comment' },
      { colorize: false }
    );
    expect(signature).toBe('function create_comment(issueId: string, parentId?: string): Comment;');
  });

  it('renders array parameters from their schema item types', () => {
    const signature = formatFunctionSignature(
      'filter_docs',
      [
        baseOption({ property: 'names', type: 'array', arrayItemType: 'string' }),
        baseOption({ property: 'scores', type: 'array', arrayItemType: 'number' }),
        baseOption({ property: 'enabled', type: 'array', arrayItemType: 'boolean' }),
        baseOption({ property: 'metadata', type: 'array', arrayItemType: 'object' }),
        baseOption({ property: 'unknownItems', type: 'array', arrayItemType: 'unknown' }),
        baseOption({ property: 'missingItems', type: 'array' }),
      ],
      undefined,
      { colorize: false }
    );

    expect(signature).toBe(
      'function filter_docs(names: string[], scores: number[], enabled: boolean[], metadata: Record<string, unknown>[], unknownItems: unknown[], missingItems: unknown[]);'
    );
  });

  it('normalizes integer item output schemas to number arrays', () => {
    const signature = formatFunctionSignature(
      'list_ids',
      [],
      { type: 'array', items: { type: 'integer' } },
      { colorize: false }
    );
    expect(signature).toBe('function list_ids(): number[];');
  });

  it('falls back to unknown return types when schema is empty', () => {
    const signature = stripAnsi(formatFunctionSignature('list_docs', [], undefined));
    expect(signature).toBe('function list_docs();');
  });
});

describe('formatCallExpressionExample', () => {
  it('uses example literals when provided and falls back for ids', () => {
    const example = formatCallExpressionExample('linear', 'create_issue', [
      baseOption({ property: 'title', required: true, exampleValue: 'Bug' }),
      baseOption({ property: 'teamId', required: true }),
      baseOption({ property: 'parentId', required: false }),
    ]);
    expect(example).toBe('mcporter call linear.create_issue(title: "Bug", teamId: "example-id")');
  });

  it('wraps expressions when requested', () => {
    const example = formatCallExpressionExample(
      'adhoc-sentry',
      'use_sentry',
      [baseOption({ property: 'request', required: true })],
      { callSelector: 'https://mcp.sentry.dev/mcp?agent=1', wrapExpression: true }
    );
    expect(example).toBe('mcporter call \'https://mcp.sentry.dev/mcp?agent=1.use_sentry(request: "value")\'');
  });
});

describe('formatExampleBlock', () => {
  it('dedupes and truncates long call hints', () => {
    const lines = formatExampleBlock(
      [
        'mcporter call linear.create_issue(title: "Bug", teamId: "ENG", description: "Long description goes here")',
        'mcporter call linear.create_issue(title: "Bug", teamId: "ENG", description: "Long description goes here")',
        'mcporter call linear.create_issue(title: "Bug", teamId: "ENG")',
      ],
      { maxExamples: 2, maxLength: 60 }
    );
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('...');
    expect(lines[1]).toContain('create_issue(');
  });
});

describe('buildToolDoc', () => {
  it('produces reusable doc blocks and summaries', () => {
    const options = [
      baseOption({
        property: 'issueId',
        cliName: 'issue-id',
        placeholder: '<issue-id>',
        description: 'Issue identifier',
        required: true,
      }),
      baseOption({
        property: 'body',
        cliName: 'body',
        placeholder: '<body>',
        description: 'Markdown body',
        required: true,
      }),
      baseOption({
        property: 'parentId',
        cliName: 'parent-id',
        placeholder: '<parent-id>',
        description: 'Optional parent',
        required: false,
      }),
    ];
    const doc = buildToolDoc({
      serverName: 'linear',
      toolName: 'create_comment',
      description: 'Create a comment',
      outputSchema: { title: 'Comment' },
      options,
      requiredOnly: true,
      colorize: false,
    });
    expect(doc.signature).toBe('function create_comment(issueId: string, body: string, parentId?: string): Comment;');
    expect(doc.tsSignature).toBe('function create_comment(issueId: string, body: string, parentId?: string): Comment;');
    expect(stripAnsi(doc.flagUsage)).toBe('--issue-id <issue-id> --body <body> [--parent-id <parent-id>]');
    expect(doc.optionalSummary).toBeUndefined();
    expect(doc.examples[0]).toContain('mcporter call linear.create_comment');
    expect(doc.optionDocs.map((entry) => entry.flagLabel)).toEqual([
      '--issue-id <issue-id>',
      '--body <body>',
      '--parent-id <parent-id>',
    ]);
    expect(doc.optionDocs[0]?.description).toContain('Issue identifier');
    expect(doc.hiddenOptions).toHaveLength(0);
  });
});

function stripAnsi(value: string): string {
  let result = '';
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '\u001B') {
      index += 1;
      while (index < value.length && value[index] !== 'm') {
        index += 1;
      }
      continue;
    }
    result += char;
  }
  return result;
}
