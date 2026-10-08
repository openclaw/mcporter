import { expect, it } from 'vitest';
import { decodeView } from '../src/daemon/view-codec.js';

it('keeps the vault encryption policy on definitions sent to the daemon', () => {
  const { definitions } = decodeView({
    definitions: [
      {
        name: 'api',
        command: { kind: 'http', url: 'https://example.com/mcp' },
        auth: 'oauth',
        oauthVaultEncryption: 'required',
      },
    ],
  });
  expect(definitions[0]?.oauthVaultEncryption).toBe('required');
});
