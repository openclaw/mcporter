import { afterEach, describe, expect, it, vi } from 'vitest';

const originalIsTTY = process.stdout.isTTY;

afterEach(() => {
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: originalIsTTY });
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('config help color output', () => {
  it('styles overview and detailed help when color is forced for a TTY', async () => {
    vi.stubEnv('FORCE_COLOR', '1');
    vi.stubEnv('NO_COLOR', undefined);
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    vi.resetModules();
    const { printConfigHelp } = await import('../src/cli/config/help.js');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printConfigHelp();
      printConfigHelp('add');
      const overview = String(log.mock.calls[0]?.[0]);
      const detail = String(log.mock.calls[1]?.[0]);
      expect(overview).toContain('\u001b[1mmcporter config\u001b[0m');
      expect(overview).toContain('\u001b[90mManage configured MCP servers');
      expect(detail).toContain('\u001b[1mFlags\u001b[0m');
      expect(detail).toContain('\u001b[38;5;244m');
    } finally {
      log.mockRestore();
    }
  });
});
