import fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { parseCallArguments } from '../src/cli/call-arguments.js';

describe('parseCallArguments', () => {
  it('parses legacy selector + key=value pairs', () => {
    const args = ['linear.list_documents', 'limit=5', 'format=json'];
    const parsed = parseCallArguments([...args]);
    expect(parsed.selector).toBe('linear.list_documents');
    expect(parsed.tool).toBeUndefined();
    expect(parsed.args.limit).toBe(5);
    expect(parsed.args.format).toBe('json');
  });

  it.each(['--server', '--mcp'] as const)('captures %s as server override', (flag) => {
    const parsed = parseCallArguments([flag, 'linear', 'list_documents']);
    expect(parsed.server).toBe('linear');
    expect(parsed.tool).toBe('list_documents');
  });

  it('consumes function-style call expressions with HTTP selectors', () => {
    const call = 'https://example.com/mcp.getComponents(limit: 3, projectId: "123")';
    const parsed = parseCallArguments([call]);
    expect(parsed.server).toBe('https://example.com/mcp');
    expect(parsed.tool).toBe('getComponents');
    expect(parsed.args.limit).toBe(3);
    expect(parsed.args.projectId).toBe('123');
  });

  it('merges --args JSON blobs with positional fragments', () => {
    const parsed = parseCallArguments([
      '--args',
      '{"query":"open issues"}',
      'linear',
      'list_documents',
      'orderBy=updatedAt',
    ]);
    expect(parsed.selector).toBe('linear');
    expect(parsed.tool).toBe('list_documents');
    expect(parsed.args.query).toBe('open issues');
    expect(parsed.args.orderBy).toBe('updatedAt');
  });

  it('parses generic --key value flags as named tool arguments', () => {
    const parsed = parseCallArguments([
      'email.send_email',
      '--to',
      '["miguel@example.com"]',
      '--subject',
      'Test',
      '--save-to-drafts',
      'true',
      '--limit=5',
    ]);
    expect(parsed.args).toEqual({
      to: ['miguel@example.com'],
      subject: 'Test',
      saveToDrafts: true,
      limit: 5,
    });
    expect(parsed.schemaStringCoercionCandidates).toEqual({ limit: '5' });
  });

  it('merges --json object payloads as an alias for --args', () => {
    const parsed = parseCallArguments([
      'email.send_email',
      '--json',
      '{"to":["miguel@example.com"],"subject":"Test","saveToDrafts":true}',
      '--text',
      'Hello',
    ]);
    expect(parsed.args).toEqual({
      to: ['miguel@example.com'],
      subject: 'Test',
      saveToDrafts: true,
      text: 'Hello',
    });
  });

  it('reads JSON object payloads from stdin when --json - is used', () => {
    const readFileSync = vi
      .spyOn(fs, 'readFileSync')
      .mockReturnValueOnce('{"to":["miguel@example.com"],"subject":"Test"}');
    try {
      const parsed = parseCallArguments(['email.send_email', '--json', '-']);
      expect(parsed.args).toEqual({
        to: ['miguel@example.com'],
        subject: 'Test',
      });
      expect(readFileSync).toHaveBeenCalledWith(0, 'utf8');
    } finally {
      readFileSync.mockRestore();
    }
  });

  it('throws when generic long flags are missing a value', () => {
    expect(() => parseCallArguments(['server.tool', '--source'])).toThrow("Flag '--source' requires a value.");
  });

  it('treats values after -- as literal positional arguments', () => {
    const parsed = parseCallArguments(['server.tool', '--', '--source', 'import', '--raw=true']);
    expect(parsed.selector).toBe('server.tool');
    expect(parsed.positionalArgs).toEqual(['--source', 'import', '--raw=true']);
  });

  it('throws when flags conflict with call expression content', () => {
    expect(() => parseCallArguments(['--server', 'linear', 'cursor.list_documents(limit:1)'])).toThrow(
      /Conflicting server names/
    );
  });

  it('treats key:=value as an alias for key=value without keeping a trailing colon', () => {
    const parsed = parseCallArguments(['schwab.placeOrder', 'price:=5.20', 'quantity:=0', 'limit:=10']);
    expect(parsed.args.price).toBe('5.20');
    expect(parsed.args.quantity).toBe(0);
    expect(parsed.args.limit).toBe(10);
    expect(parsed.schemaStringCoercionCandidates).toEqual({ quantity: '0', limit: '10' });
    expect(parsed.args).not.toHaveProperty('price:');
  });

  it('leaves := inside values untouched', () => {
    const parsed = parseCallArguments(['server.tool', 'expr=value:=x']);
    expect(parsed.args.expr).toBe('value:=x');
    expect(parsed.args).not.toHaveProperty('expr:');
  });

  it('warns when colon-style arguments omit a value', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const parsed = parseCallArguments(['iterm-mcp.write_to_terminal', 'command:']);
    expect(parsed.args.command).toBe('');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[mcporter] Argument 'command' was provided without a value.")
    );
    warnSpy.mockRestore();
  });

  it.each([
    ['default', [], 123456, 'number'],
    ['raw-strings', ['--raw-strings'], '123456', 'string'],
    ['no-coerce', ['--no-coerce'], '123456', 'string'],
  ] as const)('handles numeric coercion in %s mode', (_mode, flags, expected, expectedType) => {
    const parsed = parseCallArguments([...flags, 'server.tool', 'code=123456']);
    expect(parsed.args.code).toBe(expected);
    expect(typeof parsed.args.code).toBe(expectedType);
  });

  it('preserves leading zeros when --raw-strings flag is used', () => {
    const parsed = parseCallArguments(['--raw-strings', 'server.tool', 'pin=000123']);
    expect(parsed.args.pin).toBe('000123');
    expect(typeof parsed.args.pin).toBe('string');
  });

  it('still coerces booleans, nulls, and JSON with --raw-strings', () => {
    const parsed = parseCallArguments(['--raw-strings', 'server.tool', 'enabled=true', 'value=null', 'meta={"a":1}']);
    expect(parsed.args.enabled).toBe(true);
    expect(parsed.args.value).toBeNull();
    expect(parsed.args.meta).toEqual({ a: 1 });
  });

  it('keeps every value as a string when --no-coerce alias is used', () => {
    const parsed = parseCallArguments([
      '--no-coerce',
      'server.tool',
      'id=007',
      'enabled=true',
      'value=null',
      'meta={"a":1}',
      '123',
    ]);
    expect(parsed.args.id).toBe('007');
    expect(parsed.args.enabled).toBe('true');
    expect(parsed.args.value).toBe('null');
    expect(parsed.args.meta).toBe('{"a":1}');
    expect(typeof parsed.args.id).toBe('string');
    expect(parsed.positionalArgs).toEqual(['123']);
  });

  it('captures --save-images output directory', () => {
    const parsed = parseCallArguments(['--save-images', './tmp/images', 'server.tool']);
    expect(parsed.saveImagesDir).toBe('./tmp/images');
  });

  it.each([
    ['--save-images', /--save-images requires a directory path/],
    ['--args', /--args requires a JSON value/],
  ] as const)('throws when %s is missing a value', (flag, expectedError) => {
    expect(() => parseCallArguments([flag])).toThrow(expectedError);
  });
});
