import type { ServerDefinition } from '../config.js';
import { isChromeDefinition } from './connection-identity.js';
import { BrowserOwnerConflict } from './browser-owner.js';

const authority = Symbol('broker transport authority');
type AuthorizedDefinition = ServerDefinition & { [authority]?: true };
export function authorizeBrokerDefinition(definition: ServerDefinition): void {
  Object.defineProperty(definition, authority, { value: true, enumerable: true });
}
export function isBrokerDefinition(definition: ServerDefinition): boolean {
  return Boolean((definition as AuthorizedDefinition | undefined)?.[authority]);
}
export function assertChromeBrokerAuthority(definition: ServerDefinition): void {
  if (isChromeDefinition(definition) && !isBrokerDefinition(definition)) {
    throw new BrowserOwnerConflict('programmatic or ephemeral Chrome attachment must use the daemon-backed runtime');
  }
}
