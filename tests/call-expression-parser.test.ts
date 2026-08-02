import { describe, expect, it } from 'vitest';
import { parseCallExpressionFragment } from '../src/cli/call-expression-parser.js';

describe('parseCallExpressionFragment', () => {
  it('returns null for ordinary CLI tokens and parses empty calls', () => {
    expect(parseCallExpressionFragment('server tool')).toBeNull();
    expect(parseCallExpressionFragment('server.tool()')).toEqual({ server: 'server', tool: 'tool', args: {} });
    expect(parseCallExpressionFragment('ping()')).toEqual({ tool: 'ping', args: {} });
  });

  it('parses named nested literals and supported unary operators', () => {
    expect(
      parseCallExpressionFragment(
        `server.tool(name: 'demo', count: -2, plus: +3, enabled: !false, empty: null, list: [1, { ok: true }])`
      )
    ).toEqual({
      server: 'server',
      tool: 'tool',
      args: {
        name: 'demo',
        count: -2,
        plus: 3,
        enabled: true,
        empty: null,
        list: [1, { ok: true }],
      },
    });
    expect(parseCallExpressionFragment(`tool({ 'quoted-key': 'value' })`)).toEqual({
      tool: 'tool',
      args: { 'quoted-key': 'value' },
    });
  });

  it('preserves positional literal arguments', () => {
    expect(parseCallExpressionFragment(`server.tool('one', 2, false, [3])`)).toEqual({
      server: 'server',
      tool: 'tool',
      args: {},
      positionalArgs: ['one', 2, false, [3]],
    });
  });

  it.each([
    ['', 'Expected a tool name'],
    ['tool(...items)', 'Spread elements are not supported'],
    ['tool([1,,2])', 'Sparse array entries are not supported'],
    ['tool(value: other)', 'Unsupported argument expression'],
    ['tool(value: -name)', 'Unary operators are only supported for numeric literals'],
    ['tool(value: !1)', 'Logical negation is only supported for boolean literals'],
    ['tool(value: ~1)', 'Unsupported unary operator'],
    ['tool({ ["key"]: 1 })', 'Computed property names are not supported'],
    ['tool({ 1: 1 })', 'Invalid argument name'],
    ['tool({ get value() { return 1 } })', 'Only simple assignments are supported'],
    ['tool({ ...value })', 'Unsupported property type'],
    ['tool(() => 1)', 'Unsupported argument expression'],
  ])('rejects unsafe expression %s', (expression, message) => {
    expect(() => parseCallExpressionFragment(expression ? expression : '()')).toThrow(message);
  });

  it('reports parser errors with context', () => {
    expect(() => parseCallExpressionFragment('tool(value:)')).toThrow('Unable to parse call expression');
  });
});
