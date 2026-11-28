import { AsyncLocalStorage } from 'node:async_hooks';
import type { OAuthAuthorizationRequest } from './oauth.js';
export const authorizationBrowser = new AsyncLocalStorage<
  (request: OAuthAuthorizationRequest, open: boolean) => boolean
>();
