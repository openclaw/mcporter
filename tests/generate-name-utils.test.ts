import { describe, expect, it } from 'vitest';
import {
  inferNameFromCommand,
  looksLikeInlineCommand,
  normalizeCommandInput,
  parseInlineCommand,
} from '../src/cli/generate/name-utils.js';

describe('generated CLI command naming', () => {
  it('derives stable names from HTTP hosts and normalizes scheme-less URLs', () => {
    expect(inferNameFromCommand('https://api.linear.app/mcp')).toBe('linear');
    expect(inferNameFromCommand('mcp.context7.com/mcp')).toBe('context7');
    expect(normalizeCommandInput('mcp.context7.com/mcp')).toBe('https://mcp.context7.com/mcp');
  });

  it('derives names from scripts, scoped packages, and positional command arguments', () => {
    expect(inferNameFromCommand({ command: 'node', args: ['/opt/tools/my-server.mjs'] })).toBe('my-server');
    expect(inferNameFromCommand({ command: 'npx', args: ['-y', '@acme/search-mcp@latest'] })).toBe('acme-search-mcp');
    expect(inferNameFromCommand({ command: 'python', args: ['-m', 'acme_server'] })).toBe('acme-server');
    expect(inferNameFromCommand({ command: '/usr/local/bin/acme-mcp', args: ['--stdio'] })).toBe('acme-mcp');
  });

  it('parses quoted inline commands without losing argument boundaries', () => {
    const input = 'node "server with spaces.mjs" --label "hello world"';
    expect(looksLikeInlineCommand(input)).toBe(true);
    expect(parseInlineCommand(input)).toEqual({
      command: 'node',
      args: ['server with spaces.mjs', '--label', 'hello world'],
    });
    expect(normalizeCommandInput(input)).toEqual({
      command: 'node',
      args: ['server with spaces.mjs', '--label', 'hello world'],
    });
    expect(inferNameFromCommand(input)).toBe('server-with-spaces');
  });

  it('distinguishes bare executables and malformed command lines from inline commands', () => {
    expect(looksLikeInlineCommand('node')).toBe(false);
    expect(looksLikeInlineCommand('')).toBe(false);
    expect(looksLikeInlineCommand('node "unterminated')).toBe(false);
    expect(normalizeCommandInput('/opt/bin/search-mcp')).toEqual({ command: '/opt/bin/search-mcp' });
    expect(() => parseInlineCommand('   ')).toThrow('--command requires a non-empty value');
  });

  it('ignores flags and assignments when choosing a positional name hint', () => {
    expect(
      inferNameFromCommand({
        command: 'runner',
        args: ['--verbose', 'TOKEN=value', 'search-service'],
      })
    ).toBe('search-service');
    expect(inferNameFromCommand({ command: 'runner', args: ['chosen', '--verbose'] })).toBe('chosen');
    expect(inferNameFromCommand({ command: 'runner', args: ['chosen', 'TOKEN=value'] })).toBe('chosen');
  });

  it('normalizes long separator runs without backtracking', () => {
    expect(inferNameFromCommand({ command: `alpha${'-'.repeat(100_000)}beta` })).toBe('alpha-beta');
  });
});
