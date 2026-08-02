import { describe, expect, it } from 'vitest';
import type { ServerDefinition } from '../src/config-schema.js';
import { pickSharedDefinitionFields } from '../src/definition-fields.js';

describe('shared definition fields', () => {
  it('projects serialized policy and OAuth fields without secrets or transport data', () => {
    const definition: ServerDefinition = {
      name: 'example',
      command: { kind: 'http', url: new URL('https://example.com/mcp') },
      auth: 'oauth',
      oauthClientId: 'client-id',
      oauthClientSecret: 'secret',
      allowedTools: ['read'],
      blockedTools: ['write'],
    };

    expect(pickSharedDefinitionFields(definition)).toEqual({
      auth: 'oauth',
      tokenCacheDir: undefined,
      clientName: undefined,
      oauthClientId: 'client-id',
      oauthClientSecretEnv: undefined,
      oauthTokenEndpointAuthMethod: undefined,
      oauthRedirectUrl: undefined,
      oauthScope: undefined,
      refresh: undefined,
      httpFetch: undefined,
      allowedTools: ['read'],
      blockedTools: ['write'],
    });
    expect(pickSharedDefinitionFields(definition)).not.toHaveProperty('oauthClientSecret');
    expect(pickSharedDefinitionFields(definition)).not.toHaveProperty('command');
  });
});
