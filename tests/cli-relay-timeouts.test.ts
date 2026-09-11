import { afterEach, expect, it, vi } from 'vitest';
import { handleList } from '../src/cli/list-command.js';
import { handleCall } from '../src/cli/call-command.js';
import { resolveServerCallTimeout, resolveListTimeout } from '../src/cli/timeouts.js';
import type { Runtime } from '../src/runtime.js';
import type { ServerDefinition } from '../src/config.js';

const chrome: ServerDefinition = {
  name: 'browser',
  command: { kind: 'stdio', command: 'npx', args: ['chrome-devtools-mcp', '--autoConnect'], cwd: '/fixture' },
};
const previousExitCode = process.exitCode;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  process.exitCode = previousExitCode;
});

it.each(['list', 'list-all', 'call'] as const)('allows cumulative relay startup time in default %s', async (mode) => {
  vi.useFakeTimers();
  vi.stubEnv('MCPORTER_LIST_TIMEOUT', '');
  vi.stubEnv('MCPORTER_CALL_TIMEOUT', '');
  process.exitCode = undefined;
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const runtime = {
    getDefinitions: () => [chrome],
    getDefinition: () => chrome,
    listTools: () => new Promise((resolve) => setTimeout(() => resolve([{ name: 'list_pages' }]), 35_000)),
    callTool: () =>
      new Promise((resolve) => setTimeout(() => resolve({ content: [{ type: 'text', text: 'relay ready' }] }), 70_000)),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as Runtime;
  const operation =
    mode === 'call'
      ? handleCall(runtime, ['browser.list_pages'])
      : handleList(runtime, mode === 'list' ? ['browser', '--json'] : ['--json']);
  const outcome = Promise.allSettled([operation]);
  await vi.advanceTimersByTimeAsync(70_001);
  expect(await outcome).toEqual([{ status: 'fulfilled', value: undefined }]);
  expect(process.exitCode).toBeUndefined();
  const output = log.mock.calls.map(([text]) => String(text)).join('\n');
  if (mode === 'call') expect(output).toContain('relay ready');
  else {
    const payload = JSON.parse(output);
    if (mode === 'list') expect(payload.status).toBe('ok');
    else expect(payload.counts.ok).toBe(1);
  }
});

it('preserves explicit command deadlines and generic-server defaults', () => {
  vi.stubEnv('MCPORTER_LIST_TIMEOUT', '');
  vi.stubEnv('MCPORTER_CALL_TIMEOUT', '');
  const plain: ServerDefinition = {
    ...chrome,
    command: { ...chrome.command, kind: 'stdio', command: 'npx', args: ['chrome-devtools-mcp'], cwd: '/fixture' },
  };
  expect(resolveListTimeout(undefined, plain)).toBe(30_000);
  expect(resolveServerCallTimeout(undefined, plain)).toBe(60_000);
  expect(resolveListTimeout(9000, chrome)).toBe(9000);
  expect(resolveServerCallTimeout(9000, chrome)).toBe(9000);
  vi.stubEnv('MCPORTER_LIST_TIMEOUT', '8000');
  vi.stubEnv('MCPORTER_CALL_TIMEOUT', '7000');
  expect(resolveListTimeout(undefined, chrome)).toBe(8000);
  expect(resolveServerCallTimeout(undefined, chrome)).toBe(7000);
  expect(resolveListTimeout(9000, chrome)).toBe(9000);
  expect(resolveServerCallTimeout(9000, chrome)).toBe(9000);
});
