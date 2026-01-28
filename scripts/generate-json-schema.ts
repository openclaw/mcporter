#!/usr/bin/env tsx
/**
 * Generate JSON Schema from Zod schemas using Zod v4's native toJSONSchema() method.
 * Run with: pnpm generate:schema
 */

import { writeFileSync } from 'node:fs';
import { RawConfigSchema } from '../src/config-schema.js';

const jsonSchema = RawConfigSchema.toJSONSchema({
  override(ctx) {
    const schema = ctx.jsonSchema;
    // Disallow additional properties on objects for stricter validation
    if (schema?.type === 'object' && schema.additionalProperties === undefined) {
      schema.additionalProperties = false;
    }
  },
});

// Allow $schema property in config files for IDE support
if (jsonSchema.properties && typeof jsonSchema.properties === 'object') {
  (jsonSchema.properties as Record<string, unknown>).$schema = {
    type: 'string',
    description: 'JSON Schema URL for IDE validation and autocomplete',
  };
}

// Add standard JSON Schema metadata with $id first for cleaner ordering
const orderedSchema = {
  $id: 'https://raw.githubusercontent.com/steipete/mcporter/main/mcporter.schema.json',
  $schema: 'http://json-schema.org/draft-07/schema#',
  ...jsonSchema,
};

const outputPath = 'mcporter.schema.json';
writeFileSync(outputPath, `${JSON.stringify(orderedSchema, null, 2)}\n`);
console.log(`Generated: ${outputPath}`);
