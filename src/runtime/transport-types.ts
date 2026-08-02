import type { Client, Transport } from '@modelcontextprotocol/client';
import type { ServerDefinition } from '../config.js';
import type { OAuthSession, OAuthSessionOptions } from '../oauth.js';
import type { ElicitationHandler } from './elicitation.js';

export interface ClientContext {
  readonly client: Client;
  readonly transport: Transport & { close(): Promise<void> };
  readonly definition: ServerDefinition;
  readonly oauthSession?: OAuthSession;
}

export interface CreateClientContextOptions {
  readonly maxOAuthAttempts?: number;
  readonly oauthTimeoutMs?: number;
  readonly onDefinitionPromoted?: (definition: ServerDefinition) => void;
  readonly allowCachedAuth?: boolean;
  readonly oauthSessionOptions?: OAuthSessionOptions;
  readonly disableOAuth?: boolean;
  readonly recordPath?: string;
  readonly replayPath?: string;
  readonly elicitationHandler?: ElicitationHandler;
}

export type WrapRecordTransport = <TTransport extends Transport>(
  transport: TTransport,
  definition: ServerDefinition,
  options: CreateClientContextOptions
) => TTransport;
