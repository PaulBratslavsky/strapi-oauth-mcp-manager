/**
 * OAuth 2.1 controller
 *
 * Discovery (RFC 9728, RFC 8414), authorization with a Strapi admin login,
 * token exchange with PKCE, dynamic client registration (RFC 7591), and
 * token revocation (RFC 7009).
 */

import type { Core } from '@strapi/strapi';
import { PLUGIN_ID } from '../pluginId';
import type { PluginConfig } from '../config';
import { OAuthError, type OAuthClient, type OAuthService, type TokenEndpointAuthMethod } from '../services/oauth';
import { signConsentTicket, verifyConsentTicket } from '../utils/crypto';
import { getBaseUrl, getEndpoints, isAllowedRegisteredRedirectUri, matchRedirectUri } from '../utils/url';
import { renderAuthorizePage, renderChooseAccessPage, renderErrorPage } from '../views/authorize-page';

const AUTH_METHODS: TokenEndpointAuthMethod[] = ['client_secret_basic', 'client_secret_post', 'none'];

// Simple in-memory brute-force guard for the login form: 5 failures per IP+email per 15 minutes.
// The map is bounded so a flood of distinct emails can't grow memory without limit.
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_MAX_TRACKED = 10_000;
const loginFailures = new Map<string, { count: number; resetAt: number }>();

const pruneLoginFailures = () => {
  const now = Date.now();
  for (const [key, entry] of loginFailures) {
    if (entry.resetAt < now) {
      loginFailures.delete(key);
    }
  }
  // Still full of active entries: evict the oldest (Maps iterate in insertion order).
  while (loginFailures.size >= LOGIN_MAX_TRACKED) {
    const oldest = loginFailures.keys().next().value;
    if (oldest === undefined) break;
    loginFailures.delete(oldest);
  }
};

const isLoginLocked = (key: string) => {
  const entry = loginFailures.get(key);
  if (!entry || entry.resetAt < Date.now()) {
    loginFailures.delete(key);
    return false;
  }
  return entry.count >= LOGIN_MAX_FAILURES;
};

const recordLoginFailure = (key: string) => {
  const entry = loginFailures.get(key);
  if (!entry || entry.resetAt < Date.now()) {
    loginFailures.delete(key);
    if (loginFailures.size >= LOGIN_MAX_TRACKED) {
      pruneLoginFailures();
    }
    loginFailures.set(key, { count: 1, resetAt: Date.now() + LOGIN_WINDOW_MS });
  } else {
    entry.count += 1;
  }
};

const str = (value: unknown) => (typeof value === 'string' ? value : undefined);

const sendOAuthError = (ctx: any, error: unknown, strapi: Core.Strapi) => {
  if (error instanceof OAuthError) {
    ctx.status = error.status;
    if (error.status === 401) {
      ctx.set('WWW-Authenticate', 'Basic realm="strapi-mcp-oauth"');
    }
    ctx.body = error.toJSON();
    return;
  }
  strapi.log.error(`[${PLUGIN_ID}] OAuth request failed: ${(error as Error)?.stack ?? error}`);
  ctx.status = 500;
  ctx.body = { error: 'server_error', error_description: 'Unexpected server error' };
};

/** RFC 6749 §2.3.1: Basic credentials are form-urlencoded before base64. */
const decodeBasicPart = (value: string) => {
  try {
    return decodeURIComponent(value.replace(/\+/g, ' '));
  } catch {
    throw new OAuthError('invalid_client', 'Invalid client credentials', 401);
  }
};

/** Client credentials from HTTP Basic (RFC 6749 §2.3.1) or the form body. */
const readClientCredentials = (ctx: any) => {
  const body = ctx.request.body ?? {};
  const header: string | undefined = ctx.request.headers.authorization;
  if (header?.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString();
    const separator = decoded.indexOf(':');
    if (separator < 0) {
      throw new OAuthError('invalid_client', 'Invalid client credentials', 401);
    }
    return {
      clientId: decodeBasicPart(decoded.slice(0, separator)),
      clientSecret: decodeBasicPart(decoded.slice(separator + 1)),
    };
  }
  return { clientId: str(body.client_id), clientSecret: str(body.client_secret) };
};

const oauthController = ({ strapi }: { strapi: Core.Strapi }) => {
  const service = (): OAuthService => strapi.plugin(PLUGIN_ID).service('oauth');
  const config = (): PluginConfig => strapi.config.get(`plugin::${PLUGIN_ID}`) as PluginConfig;

  const sendHtml = (ctx: any, status: number, html: string, formTarget?: string) => {
    ctx.status = status;
    ctx.type = 'html';
    ctx.set('Cache-Control', 'no-store');
    ctx.set('X-Frame-Options', 'DENY');
    // Browsers apply form-action to the redirect that follows a form POST, so the
    // client's redirect origin must be allowed or the final hop is blocked.
    ctx.set(
      'Content-Security-Policy',
      `default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'${
        formTarget ? ` ${formTarget}` : ''
      }`
    );
    ctx.body = html;
  };

  const redirectOriginForCsp = (redirectUri: string) => {
    try {
      const url = new URL(redirectUri);
      return url.origin !== 'null' ? url.origin : url.protocol;
    } catch {
      return undefined;
    }
  };

  const redirectWith = (ctx: any, redirectUri: string, params: Record<string, string | undefined>) => {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) {
        url.searchParams.set(key, value);
      }
    }
    ctx.redirect(url.toString());
  };

  /**
   * Validate an authorization request. Returns the client, or renders an error
   * page itself when the client or redirect URI can't be trusted (never redirect then).
   */
  const validateAuthorizationRequest = async (ctx: any, input: Record<string, any>) => {
    const clientId = str(input.client_id);
    const redirectUri = str(input.redirect_uri);

    const client = clientId ? await service().findClient(clientId) : null;
    if (!client) {
      sendHtml(ctx, 400, renderErrorPage('Unknown or inactive client. The client may need to register again.'));
      return null;
    }
    if (!redirectUri || !matchRedirectUri(redirectUri, client.redirectUris)) {
      strapi.log.warn(`[${PLUGIN_ID}] Rejected redirect_uri "${redirectUri}" for client ${client.clientId}`);
      sendHtml(ctx, 400, renderErrorPage('The redirect URI is not registered for this client.'));
      return null;
    }

    const state = str(input.state);
    const fail = (error: string, description: string) => {
      redirectWith(ctx, redirectUri, { error, error_description: description, state });
      return null;
    };

    if (input.response_type !== 'code') {
      return fail('unsupported_response_type', 'Only response_type=code is supported');
    }
    const codeChallenge = str(input.code_challenge);
    const method = str(input.code_challenge_method) ?? (codeChallenge ? 'S256' : undefined);
    if (codeChallenge && method !== 'S256') {
      return fail('invalid_request', 'Only the S256 code_challenge_method is supported');
    }
    if (!codeChallenge && client.tokenEndpointAuthMethod === 'none') {
      return fail('invalid_request', 'code_challenge is required for public clients');
    }

    return { client, redirectUri, state, codeChallenge, codeChallengeMethod: method };
  };

  const authorizePageProps = (ctx: any, client: OAuthClient, input: Record<string, any>) => ({
    clientName: client.name,
    redirectUri: input.redirect_uri,
    registrationType: client.registrationType,
    resource: str(input.resource) ?? getEndpoints(ctx, strapi).resource,
    params: {
      response_type: 'code',
      client_id: str(input.client_id),
      redirect_uri: str(input.redirect_uri),
      state: str(input.state),
      code_challenge: str(input.code_challenge),
      code_challenge_method: str(input.code_challenge_method),
      scope: str(input.scope),
      resource: str(input.resource),
    },
  });

  return {
    /** RFC 9728 Protected Resource Metadata for /mcp. */
    async protectedResource(ctx: any) {
      const endpoints = getEndpoints(ctx, strapi);
      ctx.set('Cache-Control', 'public, max-age=300');
      ctx.body = {
        resource: endpoints.resource,
        authorization_servers: [endpoints.issuer],
        bearer_methods_supported: ['header'],
        resource_name: 'Strapi MCP server',
      };
    },

    /** RFC 8414 Authorization Server Metadata. */
    async authorizationServer(ctx: any) {
      const endpoints = getEndpoints(ctx, strapi);
      ctx.set('Cache-Control', 'public, max-age=300');
      ctx.body = {
        issuer: endpoints.issuer,
        authorization_endpoint: endpoints.authorization,
        token_endpoint: endpoints.token,
        ...(config().dynamicClientRegistration ? { registration_endpoint: endpoints.registration } : {}),
        revocation_endpoint: endpoints.revocation,
        response_types_supported: ['code'],
        response_modes_supported: ['query'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_methods_supported: AUTH_METHODS,
        revocation_endpoint_auth_methods_supported: AUTH_METHODS,
        code_challenge_methods_supported: ['S256'],
      };
    },

    /** GET: show the sign-in and consent page. */
    async authorize(ctx: any) {
      const request = await validateAuthorizationRequest(ctx, ctx.query);
      if (!request) {
        return;
      }
      sendHtml(
        ctx,
        200,
        renderAuthorizePage(authorizePageProps(ctx, request.client, ctx.query)),
        redirectOriginForCsp(request.redirectUri)
      );
    },

    /**
     * POST, in two steps:
     * 1. `signin`: check the admin credentials, then show the access picker.
     * 2. `choose`: verify the signed consent ticket and the chosen access, then redirect back with a code.
     */
    async authorizeSubmit(ctx: any) {
      const body = ctx.request.body ?? {};
      const request = await validateAuthorizationRequest(ctx, body);
      if (!request) {
        return;
      }
      const { client, redirectUri, state } = request;
      const csp = redirectOriginForCsp(redirectUri);
      const pageProps = authorizePageProps(ctx, client, body);

      if (body.decision === 'deny') {
        return redirectWith(ctx, redirectUri, {
          error: 'access_denied',
          error_description: 'The user denied the request',
          state,
        });
      }

      // The ticket is bound to this exact authorization request.
      const binding = [client.clientId, redirectUri, request.codeChallenge ?? '', state ?? ''].join('|');
      const secret = (strapi.config.get('admin.auth.secret') ?? strapi.config.get('admin.secrets.encryptionKey')) as string;
      if (!secret) {
        return sendHtml(ctx, 500, renderErrorPage('Strapi is missing admin.auth.secret.'));
      }

      const mappedToken = await service().getMappedToken(client);

      /**
       * Checks for clients mapped to one admin token: the token must still exist, and only its
       * owner may approve. Returns an error message, or null when the user may continue.
       */
      const mappedTokenError = (user: { id: number }) => {
        if (!mappedToken) {
          return null;
        }
        if (mappedToken.missing) {
          return `The admin token for ${client.name} was deleted. Ask an admin to choose a new one on the MCP OAuth page.`;
        }
        if (mappedToken.ownerId !== user.id) {
          return `${client.name} is set up to use an admin token that belongs to someone else. Only that token's owner can connect it.`;
        }
        return null;
      };

      const showChooseAccess = async (user: { id: number; email: string }, ticket: string, status = 200, error?: string) => {
        const ownTokens = await service().listSelectableTokens(user.id);
        const tokens = mappedToken ? ownTokens.filter((t) => t.id === mappedToken.id) : ownTokens;
        sendHtml(
          ctx,
          status,
          renderChooseAccessPage({
            ...pageProps,
            error:
              error ??
              (mappedToken && tokens.length === 0
                ? 'The admin token for this client has expired or can no longer be used. Ask an admin to choose a new one.'
                : undefined),
            userEmail: user.email,
            ticket,
            tokens,
            fixedToken: Boolean(mappedToken) && tokens.length === 1,
            allowUserPermissions: !mappedToken && config().allowUserPermissions,
            tokensSettingsUrl: `${getBaseUrl(ctx, strapi)}/admin/settings/admin-tokens`,
          }),
          csp
        );
      };

      if (body.step === 'choose') {
        const userId = typeof body.ticket === 'string' ? verifyConsentTicket(secret, body.ticket, binding) : null;
        const user = userId
          ? await strapi.db.query('admin::user').findOne({ where: { id: userId }, select: ['id', 'email', 'isActive', 'blocked'] })
          : null;
        if (!user || user.isActive !== true || user.blocked === true) {
          return sendHtml(ctx, 401, renderAuthorizePage({ ...pageProps, error: 'Your sign-in expired. Sign in again.' }), csp);
        }

        const mappingError = mappedTokenError(user);
        if (mappingError) {
          return sendHtml(ctx, 403, renderAuthorizePage({ ...pageProps, error: mappingError }), csp);
        }

        if (body.decision === 'refresh') {
          return showChooseAccess(user, body.ticket);
        }

        const access = str(body.access) ?? '';
        let adminTokenId: number | null = null;
        if (mappedToken && access !== `token:${mappedToken.id}`) {
          return showChooseAccess(user, body.ticket, 400, `${client.name} can only use its mapped admin token.`);
        }
        if (access === 'user') {
          if (!config().allowUserPermissions) {
            return showChooseAccess(user, body.ticket, 400, 'Choose one of your admin tokens.');
          }
        } else {
          const tokenId = Number(access.replace(/^token:/, ''));
          const selectable = await service().listSelectableTokens(user.id);
          if (!access.startsWith('token:') || !selectable.some((t) => t.id === tokenId)) {
            return showChooseAccess(user, body.ticket, 400, 'Choose one of your admin tokens.');
          }
          adminTokenId = tokenId;
        }

        try {
          const code = await service().createAuthorizationCode({
            client,
            adminUserId: user.id,
            adminTokenId,
            redirectUri,
            codeChallenge: request.codeChallenge,
            codeChallengeMethod: request.codeChallengeMethod,
            scope: str(body.scope),
            resource: str(body.resource),
          });
          strapi.log.info(
            `[${PLUGIN_ID}] ${user.email} authorized client "${client.name}" with ${adminTokenId ? `admin token ${adminTokenId}` : 'their own permissions'}`
          );
          return redirectWith(ctx, redirectUri, { code, state, iss: getEndpoints(ctx, strapi).issuer });
        } catch (error) {
          strapi.log.error(`[${PLUGIN_ID}] Failed to create authorization code: ${(error as Error).stack}`);
          return redirectWith(ctx, redirectUri, { error: 'server_error', state });
        }
      }

      // Step 1: sign in.
      const email = str(body.email)?.trim().toLowerCase() ?? '';
      const password = str(body.password) ?? '';
      const lockKey = `${ctx.request.ip}|${email}`;
      const rerender = (status: number, error: string) =>
        sendHtml(ctx, status, renderAuthorizePage({ ...pageProps, email, error }), csp);

      if (isLoginLocked(lockKey)) {
        return rerender(429, 'Too many failed attempts. Wait 15 minutes and try again.');
      }

      const [, user, info] = await (strapi.service('admin::auth') as any).checkCredentials({ email, password });
      if (!user) {
        recordLoginFailure(lockKey);
        return rerender(401, info?.message === 'User not active' ? 'This admin account is not active.' : 'Invalid email or password.');
      }
      loginFailures.delete(lockKey);

      const mappingError = mappedTokenError(user);
      if (mappingError) {
        strapi.log.warn(`[${PLUGIN_ID}] ${user.email} cannot connect "${client.name}": ${mappingError}`);
        return rerender(403, mappingError);
      }

      return showChooseAccess(user, signConsentTicket(secret, user.id, binding));
    },

    async token(ctx: any) {
      ctx.set('Cache-Control', 'no-store');
      ctx.set('Pragma', 'no-cache');
      const body = ctx.request.body ?? {};
      try {
        const { clientId, clientSecret } = readClientCredentials(ctx);
        const client = await service().authenticateClient(clientId, clientSecret);

        if (body.grant_type === 'authorization_code') {
          ctx.body = await service().exchangeAuthorizationCode(client, {
            code: str(body.code),
            redirectUri: str(body.redirect_uri),
            codeVerifier: str(body.code_verifier),
          });
        } else if (body.grant_type === 'refresh_token') {
          ctx.body = await service().refreshGrant(client, str(body.refresh_token));
        } else {
          throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
        }
      } catch (error) {
        sendOAuthError(ctx, error, strapi);
      }
    },

    /** RFC 7591 dynamic client registration. */
    async register(ctx: any) {
      ctx.set('Cache-Control', 'no-store');
      try {
        if (!config().dynamicClientRegistration) {
          throw new OAuthError('access_denied', 'Dynamic client registration is disabled', 403);
        }
        const body = ctx.request.body ?? {};
        const redirectUris = body.redirect_uris;
        if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > 10) {
          throw new OAuthError('invalid_redirect_uri', 'redirect_uris must be a non-empty array');
        }
        const invalid = redirectUris.find((uri: unknown) => !isAllowedRegisteredRedirectUri(uri));
        if (invalid !== undefined) {
          throw new OAuthError(
            'invalid_redirect_uri',
            `Redirect URI not allowed: ${String(invalid)}. Use https, http on localhost, or a native app scheme.`
          );
        }

        const method = (body.token_endpoint_auth_method ?? 'client_secret_basic') as TokenEndpointAuthMethod;
        if (!AUTH_METHODS.includes(method)) {
          throw new OAuthError('invalid_client_metadata', `Unsupported token_endpoint_auth_method: ${method}`);
        }
        const grantTypes: string[] = body.grant_types ?? ['authorization_code', 'refresh_token'];
        if (!Array.isArray(grantTypes) || grantTypes.some((g) => !['authorization_code', 'refresh_token'].includes(g))) {
          throw new OAuthError('invalid_client_metadata', 'Only authorization_code and refresh_token grants are supported');
        }

        const clientName = str(body.client_name);
        const { clientId, clientSecret } = await service().registerClient({
          clientName,
          redirectUris,
          tokenEndpointAuthMethod: method,
        });
        strapi.log.info(`[${PLUGIN_ID}] Registered dynamic client "${clientName ?? clientId}"`);

        ctx.status = 201;
        ctx.body = {
          client_id: clientId,
          ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
          client_id_issued_at: Math.floor(Date.now() / 1000),
          client_name: clientName,
          redirect_uris: redirectUris,
          grant_types: grantTypes,
          response_types: ['code'],
          token_endpoint_auth_method: method,
        };
      } catch (error) {
        sendOAuthError(ctx, error, strapi);
      }
    },

    /** RFC 7009 token revocation. Always 200 for unknown tokens. */
    async revoke(ctx: any) {
      ctx.set('Cache-Control', 'no-store');
      try {
        const { clientId, clientSecret } = readClientCredentials(ctx);
        const client = await service().authenticateClient(clientId, clientSecret);
        const token = str(ctx.request.body?.token);
        if (!token) {
          throw new OAuthError('invalid_request', 'token is required');
        }
        await service().revokeByToken(client, token);
        ctx.status = 200;
        ctx.body = {};
      } catch (error) {
        sendOAuthError(ctx, error, strapi);
      }
    },
  };
};

export default oauthController;
