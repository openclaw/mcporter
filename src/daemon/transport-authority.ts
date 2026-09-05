import type { ServerDefinition } from '../config.js';
import { isChromeDefinition } from './connection-identity.js';
import { BrowserOwnerConflict } from './browser-owner.js';

const authority = Symbol('broker transport authority');
type AuthorizedDefinition = ServerDefinition & { [authority]?: { validateRequest?: () => Promise<unknown> } };
export function authorizeBrokerDefinition(
  definition: ServerDefinition,
  validateRequest?: () => Promise<unknown>
): void {
  Object.defineProperty(definition, authority, { value: { validateRequest }, enumerable: true });
}

// Kept on the in-process definition only; neither the callback nor authority crosses IPC.
export function validateBrokerRequestAuthority(definition: ServerDefinition | undefined): Promise<unknown> | undefined {
  return (definition as AuthorizedDefinition | undefined)?.[authority]?.validateRequest?.();
}

export function isBrokerDefinition(definition: ServerDefinition): boolean {
  return Boolean((definition as AuthorizedDefinition | undefined)?.[authority]);
}
export function assertChromeBrokerAuthority(definition: ServerDefinition): void {
  if (isChromeDefinition(definition) && !isBrokerDefinition(definition)) {
    throw new BrowserOwnerConflict('programmatic or ephemeral Chrome attachment must use the daemon-backed runtime');
  }
}
