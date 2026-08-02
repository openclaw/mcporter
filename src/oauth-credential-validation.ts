import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/client';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isOptionalString(record: UnknownRecord, key: string): boolean {
  return record[key] === undefined || typeof record[key] === 'string';
}

function isOptionalFiniteNumber(record: UnknownRecord, key: string): boolean {
  return record[key] === undefined || (typeof record[key] === 'number' && Number.isFinite(record[key]));
}

export function isStoredOAuthTokens(value: unknown): value is OAuthTokens {
  if (!isRecord(value)) return false;
  return (
    typeof value.access_token === 'string' &&
    value.access_token.length > 0 &&
    typeof value.token_type === 'string' &&
    value.token_type.length > 0 &&
    isOptionalString(value, 'refresh_token') &&
    isOptionalString(value, 'scope') &&
    isOptionalString(value, 'issuer') &&
    isOptionalFiniteNumber(value, 'expires_in') &&
    isOptionalFiniteNumber(value, 'expires_at') &&
    isOptionalFiniteNumber(value, 'expiresAt')
  );
}

export function isStoredOAuthClientInformation(value: unknown): value is OAuthClientInformationMixed {
  if (!isRecord(value)) return false;
  return isOptionalString(value, 'issuer');
}
