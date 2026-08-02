import type { ServerDefinition } from './config-schema.js';

const SHARED_DEFINITION_FIELDS = [
  'auth',
  'tokenCacheDir',
  'clientName',
  'oauthClientId',
  'oauthClientSecretEnv',
  'oauthTokenEndpointAuthMethod',
  'oauthRedirectUrl',
  'oauthScope',
  'refresh',
  'httpFetch',
  'allowedTools',
  'blockedTools',
] as const satisfies readonly (keyof ServerDefinition)[];

type SharedDefinitionField = (typeof SHARED_DEFINITION_FIELDS)[number];
export type SharedDefinitionFields = Pick<ServerDefinition, SharedDefinitionField>;

export function pickSharedDefinitionFields(definition: ServerDefinition): SharedDefinitionFields {
  return Object.fromEntries(
    SHARED_DEFINITION_FIELDS.map((field) => [field, definition[field]])
  ) as SharedDefinitionFields;
}
