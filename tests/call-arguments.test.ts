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

  it('throws when flags conflict with call expression content', () => {
    expect(() => parseCallArguments(['--server', 'linear', 'cursor.list_documents(limit:1)'])).toThrow(
      /Conflicting server names/
    );
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

  it('coerces numeric strings to numbers by default', () => {
    const parsed = parseCallArguments(['server.tool', 'code=123456']);
    expect(parsed.args.code).toBe(123456);
    expect(typeof parsed.args.code).toBe('number');
  });

  it('preserves numeric strings when --raw-strings flag is used', () => {
    const parsed = parseCallArguments(['--raw-strings', 'server.tool', 'code=123456']);
    expect(parsed.args.code).toBe('123456');
    expect(typeof parsed.args.code).toBe('string');
    expect(parsed.rawStrings).toBe(true);
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
});
