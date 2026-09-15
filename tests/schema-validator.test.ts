import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOutputSchemaValidator } from '../src/runtime/schema-validator.js';

afterEach(() => vi.restoreAllMocks());

describe('output schema format compatibility', () => {
  it('preserves literal data, property names, and the caller-owned schema', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const compile = vi.spyOn(AjvJsonSchemaValidator.prototype, 'getValidator');
    const literal = { format: 'uint32', properties: { format: 'uint64' } };
    const schema = {
      type: 'object' as const,
      properties: {
        format: { type: 'integer' as const, format: 'uint32', minimum: 0 },
        literal: { const: literal, default: literal, examples: [literal], 'x-metadata': literal },
        choice: { enum: [{ format: 'uint64' }] },
        blocked: false,
      },
      required: ['format', 'literal'],
      additionalProperties: false,
    };
    const original = structuredClone(schema);
    const provider = createOutputSchemaValidator();
    const validate = provider.getValidator(schema);
    expect(validate({ format: 1, literal, choice: { format: 'uint64' } }).valid).toBe(true);
    expect(validate({ format: 1, literal: { properties: { format: 'uint64' } } }).valid).toBe(false);
    expect(validate({ format: 1, literal, blocked: 1 }).valid).toBe(false);
    expect(schema).toEqual(original);
    const normalized = compile.mock.calls[0]?.[0];
    expect(normalized).toMatchObject({
      properties: { literal: schema.properties.literal, choice: schema.properties.choice },
    });
    provider.getValidator(schema);
    expect(compile.mock.calls[1]?.[0]).toBe(normalized);
    expect(warn).not.toHaveBeenCalled();
  });

  it('normalizes referenced definitions and conditional subschemas', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const validate = createOutputSchemaValidator().getValidator({
      type: 'object',
      $defs: { id: { type: 'integer', format: 'uint64', minimum: 0 } },
      properties: { ids: { type: 'array', items: { $ref: '#/$defs/id' } }, extra: {} },
      required: ['ids'],
      if: { required: ['extra'] },
      // eslint-disable-next-line unicorn/no-thenable -- JSON Schema conditional keyword.
      then: { properties: { extra: { type: 'integer', format: 'uint32', minimum: 0 } } },
      else: true,
      unevaluatedProperties: false,
    });
    expect(validate({ ids: [0, 123] }).valid).toBe(true);
    expect(validate({ ids: [-1] }).valid).toBe(false);
    expect(validate({ ids: [], extra: 'wrong' }).valid).toBe(false);
    expect(validate({ ids: [], unexpected: 1 }).valid).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('preserves tuple validation for the declared schema dialect', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const validate = createOutputSchemaValidator().getValidator({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'array',
      prefixItems: [{ type: 'integer', format: 'uint32', minimum: 0 }],
      items: false,
    });
    expect(validate([123]).valid).toBe(true);
    expect(validate(['wrong']).valid).toBe(false);
    expect(validate([123, 456]).valid).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not silence unrelated unknown-format diagnostics or compilation errors', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const provider = createOutputSchemaValidator();
    provider.getValidator({ type: 'string', format: 'vendor-unrecognized' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('vendor-unrecognized'));
    expect(() => provider.getValidator({ type: 'string', pattern: '[' })).toThrow();
  });
});
