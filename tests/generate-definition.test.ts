import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveServerDefinition } from '../src/cli/generate/definition.js';
import { serializeDefinition } from '../src/cli-metadata.js';

const FIXTURE_CONFIG = path.resolve(__dirname, 'fixtures', 'mcporter.json');

describe('resolveServerDefinition HTTP selectors', () => {
  it('resolves configured servers by HTTPS URL', async () => {
    const { name } = await resolveServerDefinition('https://www.shadcn.io/api/mcp', FIXTURE_CONFIG);
    expect(name).toBe('shadcn');
  });

  it('resolves configured servers by scheme-less selectors with tool suffixes', async () => {
    const { name } = await resolveServerDefinition('shadcn.io/api/mcp.getComponent', FIXTURE_CONFIG);
    expect(name).toBe('shadcn');
  });

  it('treats raw HTTPS paths without scheme as stdio commands in inline definitions', async () => {
    const inline = JSON.stringify({ name: 'context7-inline', command: 'mcp.context7.com/mcp' });
    const { definition, name } = await resolveServerDefinition(inline);
    expect(name).toBe('context7-inline');
    expect(definition.command.kind).toBe('stdio');
    expect((definition.command as { command: string }).command).toBe('mcp.context7.com/mcp');
  });

  it('preserves a config-file protocol version pin in generated definitions', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcporter-generate-definition-'));
    const configPath = path.join(tempDir, 'mcporter.json');
    await fs.writeFile(
      configPath,
      JSON.stringify({
        mcpServers: {
          modern: {
            command: 'https://modern.example.com/mcp',
            protocolVersion: '2026-07-28',
          },
        },
      })
    );

    try {
      const { definition } = await resolveServerDefinition(configPath);
      expect(definition.protocolVersion).toBe('2026-07-28');
      expect(serializeDefinition(definition).protocolVersion).toBe('2026-07-28');
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves a snake-case protocol version pin in inline generated definitions', async () => {
    const inline = JSON.stringify({
      name: 'modern-inline',
      command: 'https://modern.example.com/mcp',
      protocol_version: '2026-07-28',
    });

    const { definition } = await resolveServerDefinition(inline);
    expect(definition.protocolVersion).toBe('2026-07-28');
    expect(serializeDefinition(definition).protocolVersion).toBe('2026-07-28');
  });
});
