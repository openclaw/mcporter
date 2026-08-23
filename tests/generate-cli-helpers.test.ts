import { Option } from 'commander';
import { describe, expect, it } from 'vitest';
import {
  buildExampleValue,
  buildFallbackLiteral,
  buildPlaceholder,
  buildToolMetadata,
  buildToolMetadataList,
  extractOptions,
  getDescriptorDefault,
  getDescriptorDescription,
  getDescriptorFormatHint,
  getEnumValues,
  inferArrayItemType,
  inferType,
  pickExampleLiteral,
  toCliOption,
  toProxyMethodName,
} from '../src/cli/generate/tools.js';
import { renderToolCommand } from '../src/cli/generate/template.js';
import type { ServerToolInfo } from '../src/runtime.js';

describe('generate helpers', () => {
  const sampleTool: ServerToolInfo = {
    name: 'add-numbers',
    description: 'Add two numbers',
    inputSchema: {
      type: 'object',
      properties: {
        firstValue: { type: 'number', description: 'First operand', default: 1 },
        mode: { type: 'string', enum: ['fast', 'accurate'] },
        extra_path: { type: 'string' },
        cursor: { type: 'string', format: 'date-time', description: 'ISO 8601 cursor' },
      },
      required: ['firstValue', 'mode'],
    },
    outputSchema: undefined,
  };

  it('builds tool metadata', () => {
    const metadata = buildToolMetadata(sampleTool);
    expect(metadata.methodName).toBe('addNumbers');
    expect(metadata.options).toHaveLength(4);
    const first = metadata.options.find((option) => option.property === 'firstValue');
    expect(first).toBeDefined();
    if (first) {
      expect(first.required).toBe(true);
    }
  });

  it('rejects generated proxy method collisions', () => {
    expect(() =>
      buildToolMetadataList([
        { name: 'some-tool', inputSchema: undefined, outputSchema: undefined },
        { name: 'some_tool', inputSchema: undefined, outputSchema: undefined },
      ])
    ).toThrow(/Generated proxy method collision 'someTool'/);
  });

  it('drops a repeated tool name instead of failing', () => {
    // Observed in the wild: a server advertised the same tool twice, which made
    // listing that server impossible.
    const metadata = buildToolMetadataList([
      { name: 'get_notifications', inputSchema: undefined, outputSchema: undefined },
      { name: 'get_notifications', inputSchema: undefined, outputSchema: undefined },
    ]);
    expect(metadata).toHaveLength(1);
    expect(metadata[0]?.tool.name).toBe('get_notifications');
  });

  it('skips ambiguous collisions when the caller opts out of throwing', () => {
    const metadata = buildToolMetadataList(
      [
        { name: 'some-tool', inputSchema: undefined, outputSchema: undefined },
        { name: 'some_tool', inputSchema: undefined, outputSchema: undefined },
      ],
      { onCollision: 'skip', sort: false }
    );
    expect(metadata).toHaveLength(1);
    expect(metadata[0]?.tool.name).toBe('some-tool');
  });

  it('extracts detailed option information', () => {
    const options = extractOptions(sampleTool);
    const first = options.find((option) => option.property === 'firstValue');
    expect(first).toBeDefined();
    if (first) {
      expect(first.placeholder).toBe('<first-value:number>');
      expect(first.exampleValue).toBe('1');
    }

    const mode = options.find((option) => option.property === 'mode');
    expect(mode).toBeDefined();
    if (mode) {
      expect(mode.enumValues).toEqual(['fast', 'accurate']);
      expect(mode.exampleValue).toBe('fast');
    }

    const extra = options.find((option) => option.property === 'extra_path');
    expect(extra).toBeDefined();
    if (extra) {
      expect(extra.placeholder).toBe('<extra-path>');
      expect(extra.exampleValue).toBe('/path/to/file.md');
    }

    const cursor = options.find((option) => option.property === 'cursor');
    expect(cursor).toBeDefined();
    if (cursor) {
      expect(cursor.placeholder).toBe('<cursor:date-time>');
      expect(cursor.formatHint).toBe('ISO 8601');
    }
  });

  it('derives helper metadata', () => {
    expect(getEnumValues(null)).toBeUndefined();
    expect(getEnumValues({ enum: ['a', 'b', 1] })).toEqual(['a', 'b']);
    expect(getEnumValues({ type: 'array', items: { enum: ['x', 'y'] } })).toEqual(['x', 'y']);
    expect(getEnumValues({ type: 'string' })).toBeUndefined();

    expect(getDescriptorDefault({ default: 'inline' })).toBe('inline');
    expect(getDescriptorDefault({ type: 'array', default: ['alpha'] })).toEqual(['alpha']);
    expect(getDescriptorDefault(null)).toBeUndefined();

    expect(buildPlaceholder('myPath', 'string', ['s1', 's2'])).toBe('<my-path:s1|s2>');
    expect(buildPlaceholder('sources', 'array', ['web', 'news'])).toBe('<sources:web|news,...>');
    expect(buildPlaceholder('createdAt', 'string', undefined, 'iso-8601')).toBe('<created-at:iso-8601>');
    expect(buildPlaceholder('fields', 'object')).toBe('<fields:json>');
    expect(buildExampleValue('itemId', 'string', undefined, undefined)).toBe('example-id');
    expect(buildExampleValue('mode', 'string', ['fast'], undefined)).toBe('fast');
    expect(buildExampleValue('fields', 'object', undefined, undefined)).toBe('{"key":"value"}');
    expect(buildExampleValue('scores', 'array', undefined, undefined, 'number')).toBe('1,2');
    expect(buildExampleValue('flags', 'array', undefined, undefined, 'boolean')).toBe('true,false');
    expect(buildExampleValue('records', 'array', undefined, undefined, 'object')).toBe('[{"key":"value"}]');

    expect(inferType({ type: 'boolean' })).toBe('boolean');
    expect(inferType({ type: 'integer' })).toBe('number');
    expect(inferType({ type: ['null', 'integer'] })).toBe('number');
    expect(inferType({ type: ['null', 'array'] })).toBe('array');
    expect(inferType({ type: 'object' })).toBe('object');
    expect(inferType({})).toBe('unknown');
    expect(inferType(null)).toBe('unknown');
    expect(inferType({ type: ['null', 'future'] })).toBe('unknown');

    expect(inferArrayItemType({ type: 'array', items: { type: 'integer' } })).toBe('number');
    expect(inferArrayItemType({ type: 'array', items: { type: ['null', 'boolean'] } })).toBe('boolean');
    expect(inferArrayItemType({ type: 'array', items: { type: 'object' } })).toBe('object');
    expect(inferArrayItemType(null)).toBe('unknown');
    expect(inferArrayItemType({ type: 'string' })).toBe('unknown');
    expect(inferArrayItemType({ type: 'array', items: { type: ['null', 'future'] } })).toBe('unknown');

    expect(getDescriptorDescription({ description: 'hi' })).toBe('hi');
    expect(getDescriptorDescription({})).toBeUndefined();
    expect(getDescriptorDescription(null)).toBeUndefined();
    expect(getDescriptorFormatHint({ format: 'uuid' })).toEqual({ display: 'UUID', slug: 'uuid' });
    expect(getDescriptorFormatHint({ description: 'Provide an ISO format timestamp' })?.slug).toBe('iso-8601');
    expect(getDescriptorFormatHint({ description: 'plain string' })).toBeUndefined();
    expect(getDescriptorFormatHint(null)).toBeUndefined();
    expect(getDescriptorFormatHint({ format: 'uri-template' })).toEqual({
      display: 'Uri Template',
      slug: 'uri-template',
    });

    expect(toProxyMethodName('some-tool_name')).toBe('someToolName');
    expect(toCliOption('inputValue')).toBe('input-value');
  });

  it('picks example literals and fallbacks consistently', () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(
      pickExampleLiteral({
        type: 'array',
        defaultValue: cyclic,
        property: 'items',
        cliName: 'items',
        required: false,
        placeholder: '<items>',
      })
    ).toBeUndefined();
    expect(
      pickExampleLiteral({
        type: 'array',
        exampleValue: ' , ',
        property: 'items',
        cliName: 'items',
        required: false,
        placeholder: '<items>',
      })
    ).toBeUndefined();
    expect(
      pickExampleLiteral({
        type: 'string',
        exampleValue: '42',
        property: 'value',
        cliName: 'value',
        required: false,
        placeholder: '<value>',
      })
    ).toBe('42');
    expect(
      pickExampleLiteral({
        type: 'number',
        exampleValue: '3',
        property: 'count',
        cliName: 'count',
        required: true,
        placeholder: '<count>',
      })
    ).toBe('3');
    expect(
      pickExampleLiteral({
        type: 'array',
        exampleValue: 'foo,bar',
        property: 'items',
        cliName: 'items',
        required: false,
        placeholder: '<items>',
      })
    ).toBe('["foo", "bar"]');
    expect(
      pickExampleLiteral({
        type: 'array',
        arrayItemType: 'number',
        exampleValue: '1,2',
        property: 'scores',
        cliName: 'scores',
        required: true,
        placeholder: '<scores>',
      })
    ).toBe('[1, 2]');
    expect(
      pickExampleLiteral({
        type: 'array',
        arrayItemType: 'boolean',
        exampleValue: 'true,false',
        property: 'flags',
        cliName: 'flags',
        required: true,
        placeholder: '<flags>',
      })
    ).toBe('[true, false]');
    expect(
      pickExampleLiteral({
        type: 'array',
        arrayItemType: 'object',
        exampleValue: '[{"key":"value"}]',
        property: 'records',
        cliName: 'records',
        required: true,
        placeholder: '<records>',
      })
    ).toBe('[{"key":"value"}]');
    expect(
      pickExampleLiteral({
        type: 'array',
        arrayItemType: 'number',
        defaultValue: [3, 5],
        property: 'scores',
        cliName: 'scores',
        required: true,
        placeholder: '<scores>',
      })
    ).toBe('[3,5]');
    expect(
      pickExampleLiteral({
        type: 'array',
        arrayItemType: 'string',
        enumValues: ['alpha', 'beta'],
        property: 'labels',
        cliName: 'labels',
        required: true,
        placeholder: '<labels>',
      })
    ).toBe('["alpha"]');
    expect(
      pickExampleLiteral({
        type: 'string',
        enumValues: ['alpha', 'beta'],
        property: 'mode',
        cliName: 'mode',
        required: true,
        placeholder: '<mode>',
      })
    ).toBe('"alpha"');
    expect(
      buildFallbackLiteral({
        type: 'string',
        property: 'issueId',
        cliName: 'issue-id',
        required: true,
        placeholder: '<issue-id>',
      })
    ).toBe('"example-id"');
    expect(
      buildFallbackLiteral({
        type: 'string',
        property: 'callbackUrl',
        cliName: 'callback-url',
        required: true,
        placeholder: '<callback-url>',
      })
    ).toBe('"https://example.com"');
    expect(
      buildFallbackLiteral({
        type: 'array',
        arrayItemType: 'number',
        property: 'scores',
        cliName: 'scores',
        required: false,
        placeholder: '<scores>',
      })
    ).toBe('[1]');
    expect(
      buildFallbackLiteral({
        type: 'array',
        arrayItemType: 'boolean',
        property: 'flags',
        cliName: 'flags',
        required: false,
        placeholder: '<flags>',
      })
    ).toBe('[true]');
    expect(
      buildFallbackLiteral({
        type: 'array',
        arrayItemType: 'object',
        property: 'records',
        cliName: 'records',
        required: false,
        placeholder: '<records>',
      })
    ).toBe('[{"key":"value"}]');
    expect(
      buildFallbackLiteral({
        type: 'array',
        property: 'labels',
        cliName: 'labels',
        required: false,
        placeholder: '<labels>',
      })
    ).toBe('["value1"]');
    expect(
      buildFallbackLiteral({
        type: 'object',
        property: 'fields',
        cliName: 'fields',
        required: false,
        placeholder: '<fields>',
      })
    ).toBe('{"key":"value"}');
  });
});

describe('flag names stay valid commander flags', () => {
  it('does not leak a leading dash from an uppercase property name', () => {
    expect(toCliOption('Query')).toBe('query');
    expect(toCliOption('QueryText')).toBe('query-text');
    expect(buildPlaceholder('Query', 'string')).toBe('<query>');
    expect(buildPlaceholder('Query', 'array', ['web', 'news'])).toBe('<query:web|news,...>');
  });

  it('avoids the --no- prefix commander reserves for negation', () => {
    expect(toCliOption('no_cache').startsWith('no-')).toBe(false);
    expect(toCliOption('noCache')).toBe(toCliOption('no_cache'));
    expect(buildPlaceholder('no_cache', 'boolean')).toBe(`<${toCliOption('no_cache')}:true|false>`);
  });

  it('keeps unaffected property names unchanged', () => {
    expect(toCliOption('inputValue')).toBe('input-value');
    expect(toCliOption('extra_path')).toBe('extra-path');
    expect(toCliOption('nodes')).toBe('nodes');
  });
});

function renderBlock(properties: Record<string, unknown>, required: string[]): string {
  return renderToolCommand(
    buildToolMetadata({ name: 'fetch', inputSchema: { type: 'object', properties, required } } as ServerToolInfo),
    30_000,
    'demo'
  ).block;
}

function emittedFlags(block: string): string[] {
  return [...block.matchAll(/\.option\("([^"]+)"/g)].flatMap((match) => (match[1] ? [match[1]] : []));
}

describe('generated commands agree with commander', () => {
  it('emits option flags commander accepts', () => {
    const flags = emittedFlags(renderBlock({ Query: { type: 'string' } }, ['Query']));
    expect(flags).toHaveLength(1);
    for (const flag of flags) {
      expect(() => new Option(flag, 'Set the option.')).not.toThrow();
    }
  });

  it('reads every option from the key commander stores it under', () => {
    const block = renderBlock({ no_cache: { type: 'boolean' }, url: { type: 'string' } }, ['no_cache', 'url']);
    const flags = emittedFlags(block);
    expect(flags).toHaveLength(2);
    for (const flag of flags) {
      expect(block).toContain(`cmdOpts.${new Option(flag, 'Set the option.').attributeName()}`);
    }
  });
});

function buildSourcesOption(type: unknown): unknown {
  return extractOptions({
    name: 'search',
    inputSchema: {
      type: 'object',
      properties: { sources: { type, items: { type: 'string', enum: ['web', 'news'] } } },
      required: [],
    },
  } as ServerToolInfo)[0];
}

describe('nullable array schemas keep their array shape', () => {
  const nullableEnumArray = {
    type: ['array', 'null'],
    items: { type: 'string', enum: ['web', 'news'] },
  };

  it('resolves item types through a nullable array container', () => {
    expect(inferArrayItemType(nullableEnumArray)).toBe('string');
    expect(inferArrayItemType({ type: ['array', 'null'], items: { type: 'number' } })).toBe('number');
  });

  it('resolves enum members through a nullable array container', () => {
    expect(getEnumValues(nullableEnumArray)).toEqual(['web', 'news']);
  });

  it('renders the same option for a nullable array as for a plain array', () => {
    expect(buildSourcesOption(['array', 'null'])).toEqual(buildSourcesOption('array'));
  });
});
