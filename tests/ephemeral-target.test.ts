import { describe, expect, it, vi } from 'vitest';
import { prepareEphemeralServerTarget } from '../src/cli/ephemeral-target.js';
import type { Runtime } from '../src/runtime.js';

function createRuntimeStub(): Runtime {
  return {
    getDefinitions: vi.fn(() => []),
    registerDefinition: vi.fn(),
  } as unknown as Runtime;
}

describe('prepareEphemeralServerTarget', () => {
  it('auto-detects inline npx commands as ad-hoc STDIO servers', async () => {
    const runtime = createRuntimeStub();
    const { target, resolution } = await prepareEphemeralServerTarget({
      runtime,
      target: 'npx -y xcodebuildmcp',
    });
    expect(target).toBe('xcodebuildmcp');
    expect(resolution?.definition.command.kind).toBe('stdio');
    if (resolution?.definition.command.kind !== 'stdio') {
      throw new Error('Expected stdio command');
    }
    expect(resolution.definition.command.command).toBe('npx');
  });

  it('does not promote a quoted empty token into an npx executable', async () => {
    const runtime = createRuntimeStub();
    const { target, resolution } = await prepareEphemeralServerTarget({
      runtime,
      target: '"" npx -y xcodebuildmcp',
    });
    expect(resolution).toBeUndefined();
    expect(target).toBe('"" npx -y xcodebuildmcp');
  });
});
