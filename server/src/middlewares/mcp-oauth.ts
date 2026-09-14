/**
 * MCP OAuth gate
 *
 * Sits in front of core's POST /mcp handler, which only understands admin tokens
 * and answers 401 without telling the client where to log in.
 *
 * - No bearer token: 401 with a WWW-Authenticate header pointing at the protected
 *   resource metadata, so MCP clients can start the OAuth flow (RFC 9728).
 * - An OAuth access token issued by this plugin: swap it for the admin token
 *   behind the grant, then let core authenticate the request as usual.
 * - Anything else (for example an admin token pasted into a client config):
 *   passed through untouched.
 */

import type { Core } from '@strapi/strapi';
import { PLUGIN_ID } from '../pluginId';
import type { OAuthService } from '../services/oauth';
import { TOKEN_PREFIX } from '../utils/crypto';
import { MCP_PATH, getEndpoints } from '../utils/url';

const extractBearerToken = (header: string | undefined) => {
  const match = header?.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
};

const unauthorized = (ctx: any, strapi: Core.Strapi, error?: { code: string; description: string }) => {
  const { protectedResourceMetadata } = getEndpoints(ctx, strapi);
  const params = [
    ...(error ? [`error="${error.code}"`, `error_description="${error.description}"`] : []),
    `resource_metadata="${protectedResourceMetadata}"`,
  ];
  ctx.status = 401;
  ctx.set('WWW-Authenticate', `Bearer ${params.join(', ')}`);
  // Same JSON-RPC shape core uses for its own auth failures.
  ctx.body = { jsonrpc: '2.0', error: { code: -32000, message: 'Authentication required' }, id: null };
};

const mcpOauthMiddleware = (_config: unknown, { strapi }: { strapi: Core.Strapi }) => {
  return async (ctx: any, next: () => Promise<void>) => {
    if (ctx.path !== MCP_PATH || ctx.method !== 'POST') {
      return next();
    }

    const token = extractBearerToken(ctx.request.headers.authorization);
    if (!token) {
      return unauthorized(ctx, strapi);
    }

    if (!token.startsWith(TOKEN_PREFIX.accessToken)) {
      return next();
    }

    const service: OAuthService = strapi.plugin(PLUGIN_ID).service('oauth');
    let result;
    try {
      result = await service.resolveAccessToken(token);
    } catch (error) {
      strapi.log.error(`[${PLUGIN_ID}] Failed to resolve MCP access token: ${(error as Error).stack}`);
      ctx.status = 500;
      ctx.body = { jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null };
      return;
    }

    if (!result.valid) {
      strapi.log.debug(`[${PLUGIN_ID}] Rejected MCP access token: ${result.reason}`);
      return unauthorized(ctx, strapi, {
        code: 'invalid_token',
        description: result.reason === 'token_expired' ? 'The access token expired' : 'The access token is invalid',
      });
    }

    // Core reads ctx.request.header.authorization, which is the same object as req.headers.
    ctx.request.headers.authorization = `Bearer ${result.adminAccessKey}`;
    ctx.state.mcpOAuthGrantId = result.grantId;
    return next();
  };
};

export default mcpOauthMiddleware;
