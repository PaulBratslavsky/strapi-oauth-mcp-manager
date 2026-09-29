import type { PluginConfig } from '../config';
import { createLineProvider } from './line';
import type { IdentityProvider } from './types';

/** The LINE provider, or null when customer sign-in with LINE is not configured. */
export const getLineProvider = (config: PluginConfig): IdentityProvider | null => {
  const line = config.identityProviders?.line;
  return line ? createLineProvider(line) : null;
};

export type { IdentityProvider, VerifiedIdentity } from './types';
