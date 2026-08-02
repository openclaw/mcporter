import { describe, expect, it } from 'vitest';
import {
  inferNameFromCommand,
  looksLikeInlineCommand,
  normalizeCommandInput,
  parseInlineCommand,
} from '../src/cli/generate/name-utils.js';

describe('generate name utilities', () => {
  it.each([
    ['https://api.example.com/mcp', 'example'],
    ['www.example.io/mcp', 'example'],
    ['node ./servers/demo.js --stdio', 'demo'],
    [`node './scripts/My Server.ts' --stdio`, 'my-server'],
    ['', undefined],
  ])('infers %s as %s', (command, expected) => {
    expect(inferNameFromCommand(command)).toBe(expected);
  });

  it('chooses scripts, packages, positional args, and executable fallback in order', () => {
    expect(inferNameFromCommand({ command: 'node', args: ['--trace', './servers/demo.mjs'] })).toBe('demo');
    expect(inferNameFromCommand({ command: 'npx', args: ['-y', '@scope/server@latest'] })).toBe('scope-server');
    expect(inferNameFromCommand({ command: 'runner', args: ['--flag', 'NAME=value', 'serve'] })).toBe('serve');
    expect(inferNameFromCommand({ command: '/usr/local/bin/mcp-server', args: ['--quiet'] })).toBe('mcp-server');
    expect(
      inferNameFromCommand({
        command: '/usr/local/bin/fallback',
        args: ['', '--quiet', 'KEY=value'],
      })
    ).toBe('fallback');
    expect(inferNameFromCommand({ command: 'runner', args: ['task'] })).toBe('task');
  });

  it('normalizes URLs, inline commands, and single executables', () => {
    expect(normalizeCommandInput('example.com/mcp')).toBe('https://example.com/mcp');
    expect(normalizeCommandInput(`node 'server file.js' --stdio`)).toEqual({
      command: 'node',
      args: ['server file.js', '--stdio'],
    });
    expect(normalizeCommandInput('node')).toEqual({ command: 'node' });
  });

  it('detects only parseable multi-token commands', () => {
    expect(looksLikeInlineCommand('')).toBe(false);
    expect(looksLikeInlineCommand('node')).toBe(false);
    expect(looksLikeInlineCommand('node server.js')).toBe(true);
    expect(looksLikeInlineCommand(`node 'unterminated`)).toBe(false);
    expect(() => parseInlineCommand('   ')).toThrow('requires a non-empty value');
  });
});
