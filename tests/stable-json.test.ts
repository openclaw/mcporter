import { describe, expect, it } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { hashDaemonDefinitions } from '../src/daemon/definition-hash.js';
import { stableJsonStringify } from '../src/stable-json.js';

describe('stableJsonStringify', () => {
  it('sorts nested plain objects while preserving arrays and omitting undefined fields', () => {
    const nullPrototype = Object.create(null) as Record<string, unknown>;
    nullPrototype.z = 3;
    nullPrototype.a = { second: 2, first: 1, omitted: undefined };

    expect(stableJsonStringify({ z: nullPrototype, a: [undefined, { y: 2, x: 1 }] })).toBe(
      '{"a":[null,{"x":1,"y":2}],"z":{"a":{"first":1,"second":2},"z":3}}'
    );
    expect(stableJsonStringify({ b: 2, a: 1 }, 2)).toBe('{\n  "a": 1,\n  "b": 2\n}');
  });

  it('rejects unsupported root values', () => {
    expect(() => stableJsonStringify(undefined)).toThrow('Cannot serialize unsupported JSON root value.');
  });

  it('preserves representative daemon definition hashes', () => {
    const definitions: ServerDefinition[] = [
      {
        name: 'beta',
        command: { kind: 'http', url: new URL('https://example.com/mcp') },
        env: { Z: 'last', A: 'first' },
      },
      { name: 'alpha', command: { kind: 'stdio', command: 'node', args: ['server.js'], cwd: '/tmp' } },
    ];

    expect(hashDaemonDefinitions(definitions)).toBe('0142df8df50b4fad');
  });
});
