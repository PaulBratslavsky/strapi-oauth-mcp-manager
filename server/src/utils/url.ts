import type { Core } from '@strapi/strapi';
import { PLUGIN_ID } from '../pluginId';

export const MCP_PATH = '/mcp';

/**
 * Public origin of this Strapi server. `server.url` wins when it is absolute;
 * otherwise use the request origin (which honours X-Forwarded-* only when
 * `server.proxy` is enabled, so a spoofed Host header can't rewrite metadata).
 */
export const getBaseUrl = (ctx: any, strapi: Core.Strapi): string => {
  const serverUrl = strapi.config.get('server.url') as string | undefined;
  if (serverUrl && /^https?:\/\//.test(serverUrl)) {
    return serverUrl.replace(/\/+$/, '');
  }
  return ctx.request.origin;
};

export const getOAuthBasePath = (strapi: Core.Strapi) => {
  const prefix = (strapi.config.get('api.rest.prefix') as string | undefined) ?? '/api';
  return `${prefix}/${PLUGIN_ID}/oauth`;
};

export const getEndpoints = (ctx: any, strapi: Core.Strapi) => {
  const base = getBaseUrl(ctx, strapi);
  const oauth = `${base}${getOAuthBasePath(strapi)}`;
  return {
    issuer: base,
    resource: `${base}${MCP_PATH}`,
    authorization: `${oauth}/authorize`,
    token: `${oauth}/token`,
    registration: `${oauth}/register`,
    revocation: `${oauth}/revoke`,
    protectedResourceMetadata: `${base}/.well-known/oauth-protected-resource${MCP_PATH}`,
    authorizationServerMetadata: `${base}/.well-known/oauth-authorization-server`,
  };
};

/**
 * Match a redirect URI against the client's allowed list. Admin-created clients may
 * use `*` as a wildcard for a run of non-slash characters (e.g. a port or subdomain).
 */
export const matchRedirectUri = (redirectUri: string, allowedPatterns: string[]) =>
  allowedPatterns.some((pattern) => {
    if (!pattern.includes('*')) {
      return pattern === redirectUri;
    }
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
    return new RegExp(`^${escaped}$`).test(redirectUri);
  });

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Redirect URIs a client may register dynamically: https, http on loopback only,
 * or a private-use scheme for native apps. No wildcards, no fragments.
 */
export const isAllowedRegisteredRedirectUri = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.includes('*')) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash) {
    return false;
  }
  if (url.protocol === 'https:') {
    return true;
  }
  if (url.protocol === 'http:') {
    return LOOPBACK_HOSTS.has(url.hostname);
  }
  return !['javascript:', 'data:', 'file:', 'vbscript:'].includes(url.protocol);
};

export const normalizeRedirectUris = (value: unknown): string[] => {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string');
  }
  if (typeof value === 'string') {
    try {
      return normalizeRedirectUris(JSON.parse(value));
    } catch {
      return [value];
    }
  }
  return [];
};
