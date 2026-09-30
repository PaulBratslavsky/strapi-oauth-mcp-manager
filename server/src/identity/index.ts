import type { PluginConfig } from '../config';
import { createLineProvider } from './line';
import type { IdentityProvider, ProviderLog } from './types';

/**
 * The LINE provider, or null when customer sign-in with LINE is not configured. `log` hears why
 * LINE couldn't be reached; the global fetch is looked up on each call, so tests can replace it.
 */
export const getLineProvider = (config: PluginConfig, log?: ProviderLog): IdentityProvider | null => {
  const line = config.identityProviders?.line;
  return line ? createLineProvider(line, fetch, log) : null;
};

export type { IdentityProvider, ProviderLog, VerifiedIdentity } from './types';
