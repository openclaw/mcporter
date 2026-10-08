import os from 'node:os';
import { describe, expect, it } from 'vitest';
import type { ServerDefinition } from '../src/config.js';
import { effectiveDefinition } from '../src/daemon/connection-identity.js';

const stdio = (env?: Record<string, string>): ServerDefinition => ({
  name: 'keep-alive-probe',
  command: { kind: 'stdio', command: 'node', args: ['server.js'], cwd: os.tmpdir() },
  env,
});

describe('effectiveDefinition and the vault variables', () => {
  const inherited = {
    ...process.env,
    MCPORTER_VAULT_PASSWORD: 'ambient-vault-password-0123456789',
    MCPORTER_VAULT_ENCRYPTION: 'optional',
    UNRELATED_AMBIENT_VAR: 'still-inherited',
  };

  it('does not carry the vault variables into a daemon-managed child environment', async () => {
    const resolved = await effectiveDefinition(stdio({ STATIC_ENV: '1' }), inherited, 'view');
    expect(resolved.env).toEqual(
      expect.objectContaining({ STATIC_ENV: '1', UNRELATED_AMBIENT_VAR: 'still-inherited' })
    );
    expect(resolved.env).not.toHaveProperty('MCPORTER_VAULT_PASSWORD');
    expect(resolved.env).not.toHaveProperty('MCPORTER_VAULT_ENCRYPTION');
  });

  it('keeps a vault password the server definition sets explicitly', async () => {
    const resolved = await effectiveDefinition(
      stdio({ MCPORTER_VAULT_PASSWORD: 'explicit-vault-password-0123456789' }),
      inherited,
      'view'
    );
    expect(resolved.env?.MCPORTER_VAULT_PASSWORD).toBe('explicit-vault-password-0123456789');
  });
});
