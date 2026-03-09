#!/usr/bin/env tsx

/**
 * Generate JSON Schema from Zod schemas using Zod v4's native toJSONSchema() method.
 * Run with: pnpm generate:schema
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { RawConfigSchema } from '../src/config-schema.js';

export const CONFIG_SCHEMA_ID = 'https://raw.githubusercontent.com/steipete/mcporter/main/mcporter.schema.json';
export const CONFIG_SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';

export function buildConfigJsonSchema(): Record<string, unknown> {
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

  return {
    ...jsonSchema,
    $id: CONFIG_SCHEMA_ID,
    $schema: CONFIG_SCHEMA_DRAFT,
  };
}

export function writeConfigJsonSchema(outputPath = 'mcporter.schema.json'): void {
  const schema = buildConfigJsonSchema();
  writeFileSync(outputPath, `${JSON.stringify(schema, null, 2)}\n`);
  console.log(`Generated: ${outputPath}`);
}

const entryPath = process.argv[1];
if (entryPath && fileURLToPath(import.meta.url) === entryPath) {
  writeConfigJsonSchema();
}
