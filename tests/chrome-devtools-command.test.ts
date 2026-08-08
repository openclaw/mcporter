import { describe, expect, it } from 'vitest';
import {
  isAmbiguousChromeDevtoolsAutoConnectCommand,
  isChromeDevtoolsToken,
  replaceChromeDevtoolsAutoConnectArgs,
  resolveChromeDevtoolsAutoConnectArgs,
  resolveChromeDevtoolsAutoConnectCommand,
} from '../src/chrome-devtools-command.js';

describe('chrome-devtools autoConnect argument resolution', () => {
  it.each([
    'chrome-devtools-mcp',
    'chrome-devtools-mcp@latest',
    '/usr/local/bin/chrome-devtools-mcp',
    'C:\\tools\\chrome-devtools-mcp.cmd',
    'C:\\TOOLS\\CHROME-DEVTOOLS-MCP.CMD',
    'C:\\repo\\node_modules\\chrome-devtools-mcp\\build\\src\\bin.js',
  ])('recognizes Chrome DevTools command token %s', (token) => {
    expect(isChromeDevtoolsToken(token)).toBe(true);
  });

  it.each(['/tmp/chrome-devtools-mcp/run.log', 'C:\\tmp\\chrome-devtools-mcp\\profile'])(
    'does not treat option value path %s as an executable',
    (token) => {
      expect(isChromeDevtoolsToken(token)).toBe(false);
    }
  );

  it.each([
    [['--autoConnect'], true, []],
    [['--auto-connect'], true, []],
    [['--autoConnect=true'], true, []],
    [['--auto-connect=TRUE'], false, []],
    [['--autoConnect', 'true'], true, []],
    [['--auto-connect', 'TRUE'], true, ['TRUE']],
    [['--autoConnect=false'], false, []],
    [['--auto-connect', 'FALSE'], true, ['FALSE']],
    [['--no-autoConnect'], false, []],
    [['--no-auto-connect'], false, []],
    [['--autoConnect=1'], false, []],
    [['--autoConnect=anything'], false, []],
    [['--no-autoConnect=false'], false, []],
  ] as const)('resolves %j with yargs boolean semantics', (args, enabled, withoutAutoConnect) => {
    expect(resolveChromeDevtoolsAutoConnectArgs(args)).toEqual({ enabled, withoutAutoConnect });
  });

  it('uses the last value and preserves target option terminators', () => {
    expect(
      resolveChromeDevtoolsAutoConnectArgs([
        'package',
        '--autoConnect=false',
        '--no-auto-connect',
        '--no-autoConnect=false',
        '--autoConnect',
        'true',
        '--other',
      ])
    ).toEqual({ enabled: true, withoutAutoConnect: ['package', '--other'] });
    expect(resolveChromeDevtoolsAutoConnectArgs(['--autoConnect', 'maybe', '--', '--no-autoConnect'])).toEqual({
      enabled: true,
      withoutAutoConnect: ['maybe', '--', '--no-autoConnect'],
    });
  });

  it('routes direct, npx, and bunx launch forms', () => {
    expect(resolveChromeDevtoolsAutoConnectCommand('chrome-devtools-mcp', ['--autoConnect'])).toEqual({
      enabled: true,
      withoutAutoConnect: [],
    });
    expect(
      resolveChromeDevtoolsAutoConnectCommand('npx', [
        '-y',
        'chrome-devtools-mcp@latest',
        '--autoConnect',
        '--logFile',
        '/tmp/chrome-devtools-mcp/run.log',
      ])
    ).toEqual({
      enabled: true,
      withoutAutoConnect: ['-y', 'chrome-devtools-mcp@latest', '--logFile', '/tmp/chrome-devtools-mcp/run.log'],
    });
    expect(resolveChromeDevtoolsAutoConnectCommand('bunx.exe', ['chrome-devtools-mcp', '--autoConnect'])).toEqual({
      enabled: true,
      withoutAutoConnect: ['chrome-devtools-mcp'],
    });
    expect(resolveChromeDevtoolsAutoConnectCommand('npx', ['--', 'chrome-devtools-mcp', '--autoConnect'])).toEqual({
      enabled: true,
      withoutAutoConnect: ['--', 'chrome-devtools-mcp'],
    });
  });

  it('does not rewrite unsupported wrappers and identifies require-only ambiguity', () => {
    for (const [command, args] of [
      ['/usr/bin/env', ['FOO=bar', 'chrome-devtools-mcp', '--autoConnect']],
      ['cmd.exe', ['/c', 'chrome-devtools-mcp', '--autoConnect']],
      ['npm', ['exec', '--', 'chrome-devtools-mcp', '--autoConnect']],
      ['powershell.exe', ['-Command', 'chrome-devtools-mcp --autoConnect; exit']],
      ['dash', ['-c', "chrome-devtools-mcp '--autoConnect'"]],
      ['fish', ['-c', 'chrome-devtools-mcp --autoConnect | cat']],
      ['sudo', ['--', 'chrome-devtools-mcp', '--autoConnect']],
    ] as const) {
      expect(resolveChromeDevtoolsAutoConnectCommand(command, args)).toEqual({
        enabled: false,
        withoutAutoConnect: args,
      });
      expect(isAmbiguousChromeDevtoolsAutoConnectCommand(command, args)).toBe(true);
    }
    expect(
      isAmbiguousChromeDevtoolsAutoConnectCommand('other-mcp', ['--', 'chrome-devtools-mcp', '--autoConnect'])
    ).toBe(false);
    expect(
      isAmbiguousChromeDevtoolsAutoConnectCommand('generic-mcp', ['--description', 'chrome-devtools-mcp --autoConnect'])
    ).toBe(false);
    expect(
      isAmbiguousChromeDevtoolsAutoConnectCommand('cmd.exe', ['/c', 'chrome-devtools-mcp --autoConnect=false'])
    ).toBe(false);
  });

  it('treats npx command strings and unknown options as ambiguous', () => {
    expect(isAmbiguousChromeDevtoolsAutoConnectCommand('npx', ['--call', 'chrome-devtools-mcp --autoConnect'])).toBe(
      true
    );
    expect(isAmbiguousChromeDevtoolsAutoConnectCommand('npx', ['--call=chrome-devtools-mcp --autoConnect'])).toBe(true);
    expect(
      isAmbiguousChromeDevtoolsAutoConnectCommand('npx', ['npm', 'exec', '--', 'chrome-devtools-mcp', '--autoConnect'])
    ).toBe(true);
    expect(
      isAmbiguousChromeDevtoolsAutoConnectCommand('npx', [
        '--unknown-option',
        'value',
        '--',
        'chrome-devtools-mcp',
        '--autoConnect',
      ])
    ).toBe(true);
    expect(
      isAmbiguousChromeDevtoolsAutoConnectCommand('npx', [
        '--package',
        'chrome-devtools-mcp',
        'other-mcp',
        '--autoConnect',
      ])
    ).toBe(false);
  });

  it('inserts relay options before the target option terminator', () => {
    expect(
      replaceChromeDevtoolsAutoConnectArgs(
        'chrome-devtools-mcp',
        ['--autoConnect', '--', 'positional'],
        ['--wsEndpoint', 'ws://127.0.0.1:1234/cdp']
      )
    ).toEqual(['--wsEndpoint', 'ws://127.0.0.1:1234/cdp', '--', 'positional']);
    expect(
      replaceChromeDevtoolsAutoConnectArgs(
        'npx',
        ['-y', 'chrome-devtools-mcp@latest', '--autoConnect', '--', 'positional'],
        ['--wsEndpoint', 'ws://127.0.0.1:1234/cdp']
      )
    ).toEqual(['-y', 'chrome-devtools-mcp@latest', '--wsEndpoint', 'ws://127.0.0.1:1234/cdp', '--', 'positional']);
  });
});
