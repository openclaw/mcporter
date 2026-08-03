import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPrefixedConsoleLogger, parseLogLevel, resolveLogLevelFromEnv } from '../src/logging.js';

describe('logging configuration', () => {
  afterEach(() => vi.restoreAllMocks());

  it('normalizes defaults, aliases, case, and whitespace', () => {
    expect(parseLogLevel(undefined, 'info')).toBe('info');
    expect(parseLogLevel('   ', 'error')).toBe('error');
    expect(parseLogLevel(' WARNING ')).toBe('warn');
    expect(parseLogLevel('Verbose')).toBe('debug');
    expect(parseLogLevel('INFO')).toBe('info');
  });

  it('rejects invalid levels and safely falls back for environment input', () => {
    expect(() => parseLogLevel('trace')).toThrow("Invalid log level 'trace'");
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveLogLevelFromEnv({ MCPORTER_LOG_LEVEL: 'trace' }, 'error')).toBe('error');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Ignoring invalid MCPORTER_LOG_LEVEL value 'trace'"));
  });

  it('prefixes enabled console levels and filters messages below the threshold', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logger = createPrefixedConsoleLogger('runtime', 'debug');
    const cause = new Error('cause');
    logger.debug?.('details');
    logger.info('ready');
    logger.warn('slow');
    logger.error('failed', cause);
    expect(debug).toHaveBeenCalledWith('[runtime] details');
    expect(log).toHaveBeenCalledWith('[runtime] ready');
    expect(warn).toHaveBeenCalledWith('[runtime] slow');
    expect(error).toHaveBeenNthCalledWith(1, '[runtime] failed');
    expect(error).toHaveBeenNthCalledWith(2, cause);

    debug.mockClear();
    log.mockClear();
    const quiet = createPrefixedConsoleLogger('quiet', 'warn');
    quiet.debug?.('hidden');
    quiet.info('hidden');
    expect(debug).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
