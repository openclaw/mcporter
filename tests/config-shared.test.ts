import { describe, expect, it, vi } from 'vitest';
import { findServerNameWithFuzzyMatch, resolveServerDefinition } from '../src/cli/config/shared.js';
import { CliUsageError } from '../src/cli/errors.js';
import type { ServerDefinition } from '../src/config-schema.js';

function buildServers(): ServerDefinition[] {
  return [
    {
      name: 'linear',
      command: { kind: 'http', url: new URL('https://linear.app/mcp'), headers: {} },
    },
    {
      name: 'slack',
      command: { kind: 'stdio', command: 'slack-mcp', args: [], cwd: '/tmp' },
    },
  ];
}

describe('config shared helpers', () => {
  it('auto-corrects close names when resolving server definitions', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const server = resolveServerDefinition('linea', buildServers(), logSpy);
    logSpy.mockRestore();
    expect(server.name).toBe('linear');
  });

  it('throws when no close match exists', () => {
    expect(() => resolveServerDefinition('unknown', buildServers(), null)).toThrow(
      new CliUsageError("Unknown server 'unknown'.")
    );
  });

  it('returns matched name when helper finds direct match', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const match = findServerNameWithFuzzyMatch('linear', ['linear', 'other'], logSpy);
    logSpy.mockRestore();
    expect(match).toBe('linear');
  });

  it('returns null when fuzzy helper has no candidate', () => {
    const match = findServerNameWithFuzzyMatch('nothing', ['alpha', 'beta'], null);
    expect(match).toBeNull();
  });
});
