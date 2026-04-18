import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { buildConfigJsonSchema, CONFIG_SCHEMA_DRAFT } from '../scripts/generate-json-schema.js';

describe('generated config schema', () => {
  it('stays in sync with the checked-in schema file', async () => {
    const schemaPath = new URL('../mcporter.schema.json', import.meta.url);
    const checkedIn = JSON.parse(await fs.readFile(schemaPath, 'utf8')) as Record<string, unknown>;
    const generated = buildConfigJsonSchema();
    expect(checkedIn).toEqual(generated);
  });

  it('includes top-level $schema, oauthScope, and tool filter properties', async () => {
    const schemaPath = new URL('../mcporter.schema.json', import.meta.url);
    const schema = JSON.parse(await fs.readFile(schemaPath, 'utf8')) as {
      $schema?: string;
      properties?: Record<string, unknown>;
    };
    expect(schema.$schema).toBe(CONFIG_SCHEMA_DRAFT);
    expect(schema.properties?.$schema).toBeDefined();

    const mcpServers = schema.properties?.mcpServers as
      | { additionalProperties?: { properties?: Record<string, unknown> } }
      | undefined;
    const entryProperties = mcpServers?.additionalProperties?.properties;
    expect(entryProperties?.oauthScope).toBeDefined();
    expect(entryProperties?.oauth_scope).toBeDefined();
    expect(entryProperties?.allowedTools).toBeDefined();
    expect(entryProperties?.allowed_tools).toBeDefined();
    expect(entryProperties?.blockedTools).toBeDefined();
    expect(entryProperties?.blocked_tools).toBeDefined();
  });
});
