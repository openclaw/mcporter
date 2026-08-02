import { describe, expect, it, vi } from 'vitest';
import { consumeInlineHelpTokens, isHelpToken, printConfigHelp } from '../src/cli/config/help.js';

describe('config help', () => {
  it('consumes help tokens without disturbing other arguments', () => {
    const args = ['list', '--help', '--json', '-h'];
    expect(consumeInlineHelpTokens(args)).toBe(true);
    expect(args).toEqual(['list', '--json']);
    expect(isHelpToken('--help')).toBe(true);
    expect(isHelpToken('-h')).toBe(true);
    expect(isHelpToken('help')).toBe(false);
  });

  it.each([
    [undefined, ['mcporter config', 'Commands', 'config add', 'detailed flag info']],
    ['ADD', ['mcporter config add', 'Usage', '--oauth-client-secret-env', 'Examples']],
    ['remove', ['mcporter config remove', 'Usage', 'config remove linear']],
    ['unknown', ["Unknown config subcommand 'unknown'", 'list, get, add']],
  ])('prints focused help for %s', (subcommand, expectedFragments) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printConfigHelp(subcommand);
      const output = String(log.mock.calls[0]?.[0]);
      for (const fragment of expectedFragments) expect(output).toContain(fragment);
    } finally {
      log.mockRestore();
    }
  });
});
