import { describe, expect, it, vi } from 'vitest';

process.env.MCPORTER_DISABLE_AUTORUN = '1';
process.env.MCPORTER_NO_FORCE_EXIT = '1';

const runtime = {
  getDefinitions: vi.fn(() => []),
  close: vi.fn(async () => undefined),
};

const createManagedRuntimeMock = vi.fn(async () => runtime);
const createRuntimeMock = vi.fn(async () => runtime);
const handleListMock = vi.fn(async () => undefined);

vi.mock('../src/runtime.js', async () => {
  const actual = await vi.importActual<typeof import('../src/runtime.js')>('../src/runtime.js');
  return {
    ...actual,
    createManagedRuntime: createManagedRuntimeMock,
    createRuntime: createRuntimeMock,
  };
});

vi.mock('../src/cli/list-command.js', async () => {
  const actual = await vi.importActual<typeof import('../src/cli/list-command.js')>('../src/cli/list-command.js');
  return {
    ...actual,
    handleList: handleListMock,
  };
});

describe('mcporter CLI managed runtime wiring', () => {
  it('uses createManagedRuntime for normal CLI commands', async () => {
    const { runCli } = await import('../src/cli.js');

    await runCli(['list']);

    expect(createManagedRuntimeMock).toHaveBeenCalledTimes(1);
    expect(createRuntimeMock).not.toHaveBeenCalled();
    expect(handleListMock).toHaveBeenCalledWith(runtime, []);
    expect(runtime.close).toHaveBeenCalledTimes(1);
  });
});
