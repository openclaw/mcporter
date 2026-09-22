import type { JsonSchemaType, jsonSchemaValidator } from '@modelcontextprotocol/client';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { isRecord } from '../config/imports/shared.js';

const schemaMaps = new Set([
  '$defs',
  'definitions',
  'properties',
  'patternProperties',
  'dependentSchemas',
  'dependencies',
]);
const subschemas = new Set([
  'additionalProperties',
  'unevaluatedProperties',
  'propertyNames',
  'items',
  'additionalItems',
  'unevaluatedItems',
  'contains',
  'contentSchema',
  'allOf',
  'anyOf',
  'oneOf',
  'prefixItems',
  'not',
  'if',
  'then',
  'else',
]);

function normalizeSchema(schema: unknown): unknown {
  if (!isRecord(schema)) return schema;
  return Object.fromEntries(
    Object.entries(schema).flatMap(([key, value]) => {
      // Rust schema generators emit these as annotations. Ajv already ignores
      // them; omit them from its compilation copy without changing validation.
      if (key === 'format' && (value === 'uint32' || value === 'uint64')) return [];
      if (schemaMaps.has(key) && isRecord(value)) {
        return [
          [key, Object.fromEntries(Object.entries(value).map(([name, child]) => [name, normalizeSchema(child)]))],
        ];
      }
      if (subschemas.has(key)) {
        return [[key, Array.isArray(value) ? value.map(normalizeSchema) : normalizeSchema(value)]];
      }
      // Defaults, examples, enum/const values and extension metadata are data.
      return [[key, value]];
    })
  );
}

export function createOutputSchemaValidator(): jsonSchemaValidator {
  const validator = new AjvJsonSchemaValidator();
  const normalizedSchemas = new WeakMap<JsonSchemaType, JsonSchemaType>();
  return {
    getValidator<T>(schema: JsonSchemaType) {
      let normalized = normalizedSchemas.get(schema);
      if (!normalized) {
        normalized = normalizeSchema(schema) as JsonSchemaType;
        normalizedSchemas.set(schema, normalized);
      }
      // Leave dialect selection and standard format validation with the SDK.
      return validator.getValidator<T>(normalized);
    },
  };
}
