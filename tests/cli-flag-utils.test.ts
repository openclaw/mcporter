import { describe, expect, it } from 'vitest';
import { expectValue, extractFlags } from '../src/cli/flag-utils.js';

describe('cli flag utils', () => {
  it('extracts targeted flags and mutates argv in place', () => {
    const argv = ['--config', '/tmp/config.json', 'list', '--root', '/repo'];
    const flags = extractFlags(argv, ['--config', '--root']);
    expect(flags['--config']).toBe('/tmp/config.json');
    expect(flags['--root']).toBe('/repo');
    expect(argv).toEqual(['list']);
  });

  it('preserves flags after the command separator for wrapped commands', () => {
    const argv = ['record', 'demo', '--', 'node', 'dist/cli.js', '--config', '/tmp/child.json', 'call'];
    const flags = extractFlags(argv, ['--config']);
    expect(flags['--config']).toBeUndefined();
    expect(argv).toEqual(['record', 'demo', '--', 'node', 'dist/cli.js', '--config', '/tmp/child.json', 'call']);
  });

  it('throws when a required flag value is missing', () => {
    expect(() => extractFlags(['--config'], ['--config'])).toThrow(/requires a value/);
    expect(() => expectValue('--output', undefined)).toThrow(/requires a value/);
  });
});
