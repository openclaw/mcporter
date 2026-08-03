import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { __test as emitInternals } from '../src/cli/emit-ts-command.js';
import { consumeOutputFormat } from '../src/cli/output-format.js';
import { parseRecordArgs, parseReplayArgs } from '../src/cli/record-command.js';

describe('emit-ts argument validation', () => {
  it.each([
    [[], 'Usage: mcporter emit-ts'],
    [['linear'], "Flag '--out' is required"],
    [['linear', '--out'], "Flag '--out' requires a path"],
    [['linear', '--types-out'], "Flag '--types-out' requires a path"],
    [['linear', '--out', 'types.txt'], '--out should be a .ts or .d.ts file'],
    [['linear', '--out', 'client.js', '--mode', 'client'], '--out should point to a .ts file'],
    [['linear', '--out', 'types.ts', '--mode', 'javascript'], "--mode must be 'types' or 'client'"],
    [['linear', '--out', 'types.ts', '--mystery'], "Unknown flag '--mystery' for emit-ts"],
  ])('rejects invalid emit-ts arguments %#', (args, message) => {
    expect(() => emitInternals.parseEmitTsArgs([...(args as string[])])).toThrow(message as string);
  });

  it('parses explicit client and types paths and derives safe identifiers', () => {
    const parsed = emitInternals.parseEmitTsArgs([
      'linear-api',
      '--out',
      'generated/client.ts',
      '--types-out',
      'generated/schema.d.ts',
      '--mode',
      'client',
      '--include-optional',
      '--json',
    ]);
    expect(parsed).toMatchObject({
      server: 'linear-api',
      mode: 'client',
      includeOptional: true,
      format: 'json',
      outPath: path.resolve('generated/client.ts'),
      typesOutPath: path.resolve('generated/schema.d.ts'),
    });
    expect(emitInternals.buildInterfaceName('123 !!!')).toBe('123Tools');
    expect(emitInternals.buildInterfaceName('!!!')).toBe('ServerTools');
    expect(emitInternals.deriveTypesOutPath('/tmp/client.ts')).toBe('/tmp/client.d.ts');
    expect(emitInternals.computeImportPath('/tmp/client.ts', '/tmp/types.ts')).toBe('./types');
  });
});

describe('shared output format parsing', () => {
  it('consumes explicit and shortcut formats', () => {
    const rawArgs = ['--raw', 'target'];
    expect(consumeOutputFormat(rawArgs)).toBe('raw');
    expect(rawArgs).toEqual(['target']);

    const jsonArgs = ['--json', 'target'];
    expect(consumeOutputFormat(jsonArgs, { jsonShortcutFlag: '--json' })).toBe('json');
    expect(jsonArgs).toEqual(['target']);
  });

  it.each([
    [['--output'], {}, "Flag '--output' requires a value"],
    [['--output', 'yaml'], {}, '--output format must be one of'],
    [['--output', 'raw'], { allowed: ['json'] }, "--output format 'raw' is not supported"],
    [['--raw'], { allowed: ['json'] }, '--raw is not supported'],
    [['--json'], { allowed: ['text'], jsonShortcutFlag: '--json' }, '--json is not supported'],
    [[], { allowed: ['json'], defaultFormat: 'text' }, "Format 'text' is not supported"],
  ])('rejects invalid output formats %#', (args, options, message) => {
    expect(() => consumeOutputFormat([...(args as string[])], options as never)).toThrow(message as string);
  });
});

describe('record and replay argument validation', () => {
  it('parses equals-style server filters and child commands', () => {
    expect(parseRecordArgs(['session', '--server=linear', '--', 'node', 'script.js'])).toEqual({
      sessionName: 'session',
      server: 'linear',
      command: ['node', 'script.js'],
    });
  });

  it.each([
    [() => parseRecordArgs([]), 'Usage: mcporter record'],
    [() => parseReplayArgs([]), 'Usage: mcporter replay'],
    [() => parseRecordArgs(['session', '--server']), "Flag '--server' requires a server name"],
    [() => parseReplayArgs(['session', '--server=']), "Flag '--server' requires a server name"],
    [() => parseRecordArgs(['session', '--bad']), "Unknown record flag '--bad'"],
    [() => parseReplayArgs(['one', 'two']), "Unexpected replay argument 'two'"],
  ])('rejects invalid record/replay arguments %#', (run, message) => {
    expect(run).toThrow(message as string);
  });
});
