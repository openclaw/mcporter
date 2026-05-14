import { describe, expect, it } from 'vitest';
import { parseServeArgs } from '../src/cli/serve-command.js';

describe('serve command arguments', () => {
  it('defaults to stdio and parses server filters', () => {
    expect(parseServeArgs(['--servers', 'alpha,beta'])).toEqual({
      mode: 'stdio',
      port: undefined,
      host: undefined,
      servers: ['alpha', 'beta'],
    });
  });

  it('parses streamable HTTP mode', () => {
    expect(parseServeArgs(['--http=3210', '--host', 'localhost'])).toEqual({
      mode: 'http',
      port: 3210,
      host: 'localhost',
      servers: undefined,
    });
  });

  it('parses equals-form host overrides', () => {
    expect(parseServeArgs(['--http', '3210', '--host=0.0.0.0'])).toEqual({
      mode: 'http',
      port: 3210,
      host: '0.0.0.0',
      servers: undefined,
    });
  });

  it('rejects invalid ports', () => {
    expect(() => parseServeArgs(['--http', 'nope'])).toThrow("Invalid HTTP port 'nope'");
    expect(() => parseServeArgs(['--http='])).toThrow("Flag '--http' requires a port.");
  });

  it('rejects conflicting stdio and HTTP modes', () => {
    expect(() => parseServeArgs(['--stdio', '--http', '3210'])).toThrow(
      "Flags '--stdio' and '--http' cannot be used together."
    );
  });

  it('rejects host overrides without HTTP mode', () => {
    expect(() => parseServeArgs(['--host', '0.0.0.0'])).toThrow("Flag '--host' can only be used with '--http'.");
  });
});
