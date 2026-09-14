/**
 * OAuth service
 *
 * Authorization server logic for the official Strapi MCP server. Each approved
 * authorization becomes a "grant": an OAuth access/refresh token pair backed by
 * an admin token owned by the admin user who approved it. Usually that is a
 * token the user created in Settings → Admin Tokens and picked on the consent page;
 * optionally the plugin mints one carrying the user's full permissions. The MCP
 * gate swaps the OAuth access token for the admin token, so core's /mcp handler
 * authenticates it like any other admin token.
 *
 * Because every backing token is owned by the approving user, deactivating or
 * deleting that user cuts off all of their MCP sessions.
 */

import type { Core } from '@strapi/strapi';
import { PLUGIN_ID } from '../pluginId';
import type { PluginConfig } from '../config';
import { TOKEN_PREFIX, generateToken, hashToken, safeEqual, verifyPkce } from '../utils/crypto';
import { normalizeRedirectUris } from '../utils/url';

const UID = {
  client: `plugin::${PLUGIN_ID}.mcp-oauth-client`,
  code: `plugin::${PLUGIN_ID}.mcp-oauth-code`,
  grant: `plugin::${PLUGIN_ID}.mcp-oauth-token`,
} as const;

export type TokenEndpointAuthMethod = 'client_secret_basic' | 'client_secret_post' | 'none';

export interface OAuthClient {
  id: number;
  name: string;
  clientId: string;
  clientSecret?: string | null;
  redirectUris: string[];
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  registrationType: 'manual' | 'dynamic';
  /** When set, every session for this client uses this admin token, and only its owner can approve. */
  adminTokenId?: number | null;
  active: boolean;
}

export class OAuthError extends Error {
  constructor(
    public error: string,
    public description: string,
    public status = 400
  ) {
    super(description);
  }

  toJSON() {
    return { error: this.error, error_description: this.description };
  }
}

export interface SelectableToken {
  id: number;
  name: string;
  description?: string | null;
  expiresAt?: string | null;
}

export type AccessTokenResult =
  | { valid: true; adminAccessKey: string; grantId: number }
  | { valid: false; reason: string };

const MINTED_TOKEN_PREFIX = 'MCP OAuth · ';

const toIso = (secondsFromNow: number) => new Date(Date.now() + secondsFromNow * 1000).toISOString();
const isExpired = (date: string | Date | null | undefined) => !date || new Date(date).getTime() <= Date.now();

const oauthService = ({ strapi }: { strapi: Core.Strapi }) => {
  const config = (): PluginConfig => strapi.config.get(`plugin::${PLUGIN_ID}`) as PluginConfig;
  const adminTokens = () => strapi.service('admin::api-token-admin') as any;

  const normalizeClient = (row: any): OAuthClient => ({
    ...row,
    redirectUris: normalizeRedirectUris(row.redirectUris),
    // A client without a secret can only ever authenticate as a public client.
    tokenEndpointAuthMethod: row.clientSecret ? row.tokenEndpointAuthMethod ?? 'client_secret_post' : 'none',
  });

  /**
   * Mint an admin token owned by `userId`, carrying that user's current
   * permissions. Core clamps it to the user's ceiling and keeps it in sync
   * when the user's roles change.
   */
  const mintAdminToken = async (userId: number, client: OAuthClient) => {
    if (!strapi.config.get('admin.secrets.encryptionKey')) {
      throw new OAuthError(
        'server_error',
        'admin.secrets.encryptionKey is not configured, so MCP OAuth grants cannot be stored. Set ENCRYPTION_KEY and restart Strapi.',
        500
      );
    }

    const user = await strapi.db.query('admin::user').findOne({ where: { id: userId }, populate: ['roles'] });
    if (!user || user.isActive !== true || user.blocked === true) {
      throw new OAuthError('invalid_grant', 'The authorizing admin user is no longer active');
    }

    const permissionService = strapi.service('admin::permission') as any;
    const knownActions = new Set<string>(permissionService.actionProvider.keys());
    const userPermissions: any[] = await permissionService.findUserPermissions(user);
    const adminPermissions = userPermissions
      .filter((p) => knownActions.has(p.action))
      .map((p) => ({
        action: p.action,
        subject: p.subject ?? null,
        properties: p.properties ?? {},
        conditions: p.conditions ?? [],
      }));

    const suffix = generateToken('', 4);
    const name = `${MINTED_TOKEN_PREFIX}${client.name.slice(0, 40)} · ${user.email} · ${suffix}`;

    return adminTokens().create(
      {
        kind: 'admin',
        name,
        description: `Issued by ${PLUGIN_ID} when ${user.email} authorized "${client.name}" (${client.clientId}). Revoking it disconnects that client.`,
        lifespan: null,
        adminPermissions,
        adminUserOwner: user.id,
      },
      user
    );
  };

  const revokeAdminToken = async (adminTokenId: number) => {
    try {
      const existing = await adminTokens().getById(adminTokenId);
      if (existing) {
        await adminTokens().revoke(adminTokenId);
      }
    } catch (error) {
      strapi.log.warn(`[${PLUGIN_ID}] Could not revoke admin token ${adminTokenId}: ${(error as Error).message}`);
    }
  };

  const isActiveUser = async (userId: number) => {
    const user = await strapi.db.query('admin::user').findOne({ where: { id: userId }, select: ['id', 'isActive', 'blocked'] });
    return Boolean(user && user.isActive === true && user.blocked !== true);
  };

  const ownerIdOf = (token: any) => {
    const owner = token?.adminUserOwner;
    return owner === null || owner === undefined ? null : Number(typeof owner === 'object' ? owner.id : owner);
  };

  /** Load an admin token the user owns, with its decrypted key. Throws OAuthError if it can't back a session. */
  const loadOwnedToken = async (tokenId: number, userId: number) => {
    const token = await adminTokens().getById(tokenId, { includeDecryptedKey: true });
    if (!token || token.kind !== 'admin' || ownerIdOf(token) !== userId) {
      throw new OAuthError('invalid_grant', 'The selected admin token no longer exists or is not yours');
    }
    if (token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now()) {
      throw new OAuthError('invalid_grant', 'The selected admin token has expired');
    }
    if (!token.accessKey) {
      throw new OAuthError(
        'invalid_grant',
        'The selected admin token cannot be used because its key cannot be read. Regenerate it in Settings → Admin Tokens.'
      );
    }
    return token;
  };

  const issueTokens = () => {
    const accessToken = generateToken(TOKEN_PREFIX.accessToken);
    const refreshToken = generateToken(TOKEN_PREFIX.refreshToken);
    const { accessTokenTtl, refreshTokenTtl } = config();
    return {
      accessToken,
      refreshToken,
      row: {
        accessTokenHash: hashToken(accessToken),
        refreshTokenHash: hashToken(refreshToken),
        expiresAt: toIso(accessTokenTtl),
        refreshExpiresAt: toIso(refreshTokenTtl),
      },
      response: (scope?: string | null) => ({
        access_token: accessToken,
        token_type: 'Bearer',
        expires_in: accessTokenTtl,
        refresh_token: refreshToken,
        ...(scope ? { scope } : {}),
      }),
    };
  };

  return {
    async findClient(clientId: string): Promise<OAuthClient | null> {
      if (!clientId) {
        return null;
      }
      const row = await strapi.db.query(UID.client).findOne({ where: { clientId, active: true } });
      return row ? normalizeClient(row) : null;
    },

    /**
     * Authenticate a client at the token/revocation endpoints. Confidential clients
     * must present their secret; public clients rely on PKCE instead.
     */
    async authenticateClient(clientId: string | undefined, clientSecret: string | undefined) {
      const client = await this.findClient(clientId ?? '');
      if (!client) {
        throw new OAuthError('invalid_client', 'Unknown or inactive client', 401);
      }
      if (client.tokenEndpointAuthMethod !== 'none') {
        if (!clientSecret || !client.clientSecret || !safeEqual(clientSecret, client.clientSecret)) {
          throw new OAuthError('invalid_client', 'Invalid client credentials', 401);
        }
      }
      return client;
    },

    /** RFC 7591 dynamic client registration. */
    async registerClient(input: {
      clientName?: string;
      redirectUris: string[];
      tokenEndpointAuthMethod: TokenEndpointAuthMethod;
    }) {
      const clientId = generateToken(TOKEN_PREFIX.clientId, 16);
      const clientSecret =
        input.tokenEndpointAuthMethod === 'none' ? null : generateToken(TOKEN_PREFIX.clientSecret);

      await strapi.db.query(UID.client).create({
        data: {
          name: (input.clientName || 'Unnamed MCP client').slice(0, 100),
          clientId,
          clientSecret,
          redirectUris: input.redirectUris,
          tokenEndpointAuthMethod: input.tokenEndpointAuthMethod,
          registrationType: 'dynamic',
          active: true,
        },
      });

      return { clientId, clientSecret };
    },

    async createAuthorizationCode(input: {
      client: OAuthClient;
      adminUserId: number;
      /** Admin token the user picked, or null for "all of my permissions". */
      adminTokenId: number | null;
      redirectUri: string;
      codeChallenge?: string;
      codeChallengeMethod?: string;
      scope?: string;
      resource?: string;
    }) {
      const code = generateToken(TOKEN_PREFIX.code);
      await strapi.db.query(UID.code).create({
        data: {
          codeHash: hashToken(code),
          clientId: input.client.clientId,
          adminUserId: input.adminUserId,
          adminTokenId: input.adminTokenId,
          redirectUri: input.redirectUri,
          codeChallenge: input.codeChallenge ?? null,
          codeChallengeMethod: input.codeChallenge ? input.codeChallengeMethod ?? 'S256' : null,
          scope: input.scope ?? null,
          resource: input.resource ?? null,
          expiresAt: toIso(config().authorizationCodeTtl),
        },
      });
      return code;
    },

    async exchangeAuthorizationCode(
      client: OAuthClient,
      params: { code?: string; redirectUri?: string; codeVerifier?: string }
    ) {
      if (!params.code) {
        throw new OAuthError('invalid_request', 'code is required');
      }

      const codeRow = await strapi.db.query(UID.code).findOne({ where: { codeHash: hashToken(params.code) } });
      // Codes are single-use: delete before doing anything else so a replay can't race us.
      if (codeRow) {
        await strapi.db.query(UID.code).delete({ where: { id: codeRow.id } });
      }

      if (!codeRow || codeRow.clientId !== client.clientId) {
        throw new OAuthError('invalid_grant', 'Invalid authorization code');
      }
      if (isExpired(codeRow.expiresAt)) {
        throw new OAuthError('invalid_grant', 'Authorization code expired');
      }
      if (codeRow.redirectUri !== params.redirectUri) {
        throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request');
      }
      if (codeRow.codeChallenge) {
        if (!params.codeVerifier || !verifyPkce(params.codeVerifier, codeRow.codeChallenge)) {
          throw new OAuthError('invalid_grant', 'PKCE verification failed');
        }
      } else if (client.tokenEndpointAuthMethod === 'none') {
        throw new OAuthError('invalid_grant', 'Public clients must use PKCE');
      }

      if (!(await isActiveUser(codeRow.adminUserId))) {
        throw new OAuthError('invalid_grant', 'The authorizing admin user is no longer active');
      }

      if (client.adminTokenId && codeRow.adminTokenId !== client.adminTokenId) {
        throw new OAuthError('invalid_grant', 'The admin token for this client changed. Authorize again.');
      }

      const ownsAdminToken = !codeRow.adminTokenId;
      if (ownsAdminToken && !config().allowUserPermissions) {
        throw new OAuthError('invalid_grant', 'Sessions must use an admin token');
      }
      const adminToken = ownsAdminToken
        ? await mintAdminToken(codeRow.adminUserId, client)
        : await loadOwnedToken(codeRow.adminTokenId, codeRow.adminUserId);
      const tokens = issueTokens();

      try {
        await strapi.db.query(UID.grant).create({
          data: {
            ...tokens.row,
            clientId: client.clientId,
            adminUserId: codeRow.adminUserId,
            adminTokenId: adminToken.id,
            ownsAdminToken,
            adminKeyHash: hashToken(adminToken.accessKey),
            scope: codeRow.scope,
            resource: codeRow.resource,
          },
        });
      } catch (error) {
        if (ownsAdminToken) {
          await revokeAdminToken(adminToken.id);
        }
        throw error;
      }

      strapi.log.info(
        `[${PLUGIN_ID}] Issued MCP grant for client "${client.name}" using ${ownsAdminToken ? 'a minted' : 'the selected'} admin token ${adminToken.id}`
      );
      return tokens.response(codeRow.scope);
    },

    /** Refresh token rotation: the old refresh token stops working immediately. */
    async refreshGrant(client: OAuthClient, refreshToken?: string) {
      if (!refreshToken) {
        throw new OAuthError('invalid_request', 'refresh_token is required');
      }

      const grant = await strapi.db.query(UID.grant).findOne({
        where: { refreshTokenHash: hashToken(refreshToken), clientId: client.clientId },
      });
      if (!grant) {
        throw new OAuthError('invalid_grant', 'Invalid refresh token');
      }
      if (isExpired(grant.refreshExpiresAt)) {
        await this.revokeGrant(grant.id);
        throw new OAuthError('invalid_grant', 'Refresh token expired');
      }
      if (!(await adminTokens().getById(grant.adminTokenId)) || !(await isActiveUser(grant.adminUserId))) {
        await this.revokeGrant(grant.id);
        throw new OAuthError('invalid_grant', 'This authorization was revoked');
      }

      const tokens = issueTokens();
      await strapi.db.query(UID.grant).update({ where: { id: grant.id }, data: tokens.row });
      return tokens.response(grant.scope);
    },

    /**
     * Resolve an OAuth access token to the admin token behind it.
     * Returns `valid: false` for unknown, expired, or revoked tokens.
     */
    async resolveAccessToken(accessToken: string): Promise<AccessTokenResult> {
      const grant = await strapi.db.query(UID.grant).findOne({ where: { accessTokenHash: hashToken(accessToken) } });
      if (!grant) {
        return { valid: false, reason: 'unknown_token' };
      }
      if (isExpired(grant.expiresAt)) {
        return { valid: false, reason: 'token_expired' };
      }

      const adminToken = await adminTokens().getById(grant.adminTokenId, { includeDecryptedKey: true });
      if (!adminToken) {
        // Someone revoked the admin token in Settings; the grant is dead.
        await this.revokeGrant(grant.id);
        return { valid: false, reason: 'grant_revoked' };
      }
      if (!adminToken.accessKey) {
        strapi.log.error(
          `[${PLUGIN_ID}] Could not decrypt admin token ${grant.adminTokenId}. Did admin.secrets.encryptionKey change?`
        );
        return { valid: false, reason: 'decrypt_failed' };
      }
      if (grant.adminKeyHash && !safeEqual(hashToken(adminToken.accessKey), grant.adminKeyHash)) {
        // The token was regenerated in Settings → Admin Tokens; treat that as a revocation.
        await this.revokeGrant(grant.id);
        return { valid: false, reason: 'grant_revoked' };
      }
      // Core already rejects tokens whose owner is inactive. The approving user is the owner,
      // but check explicitly so a deactivated user is cut off even if that ever changes.
      if (!(await isActiveUser(grant.adminUserId))) {
        return { valid: false, reason: 'user_inactive' };
      }

      // Best effort; a failed timestamp write must not block the request.
      strapi.db
        .query(UID.grant)
        .update({ where: { id: grant.id }, data: { lastUsedAt: new Date().toISOString() } })
        .catch(() => {});

      return { valid: true, adminAccessKey: adminToken.accessKey, grantId: grant.id };
    },

    /** RFC 7009: revoke by access or refresh token. Unknown tokens are not an error. */
    async revokeByToken(client: OAuthClient, token: string) {
      const hash = hashToken(token);
      const grant = await strapi.db.query(UID.grant).findOne({
        where: { clientId: client.clientId, $or: [{ accessTokenHash: hash }, { refreshTokenHash: hash }] },
      });
      if (grant) {
        await this.revokeGrant(grant.id);
      }
    },

    async revokeGrant(grantId: number) {
      const grant = await strapi.db.query(UID.grant).findOne({ where: { id: grantId } });
      if (!grant) {
        return false;
      }
      await strapi.db.query(UID.grant).delete({ where: { id: grantId } });
      // Only delete tokens this plugin minted. Tokens the user picked stay in Settings.
      if (grant.ownsAdminToken) {
        await revokeAdminToken(grant.adminTokenId);
      }
      return true;
    },

    /**
     * The admin token mapped to a client, with its owner. `missing` means a token was mapped
     * but has since been deleted, so the client must not connect until an admin fixes it.
     */
    async getMappedToken(client: OAuthClient): Promise<{ id: number; name: string; ownerId: number | null; missing: boolean } | null> {
      if (!client.adminTokenId) {
        return null;
      }
      const token = await strapi.db.query('admin::api-token').findOne({
        where: { id: client.adminTokenId, kind: 'admin' },
        select: ['id', 'name', 'description', 'expiresAt'],
        populate: ['adminUserOwner'],
      });
      if (!token) {
        return { id: client.adminTokenId, name: '', ownerId: null, missing: true };
      }
      return { id: token.id, name: token.name, ownerId: ownerIdOf(token), missing: false };
    },

    /**
     * Map an admin token to a client, or clear the mapping with null. The acting admin must own
     * the token. Existing sessions end because they may be using a different token.
     */
    async setClientToken(id: number, adminTokenId: number | null, actingUserId: number) {
      const client = await strapi.db.query(UID.client).findOne({ where: { id } });
      if (!client) {
        return null;
      }
      if (adminTokenId !== null) {
        const selectable = await this.listSelectableTokens(actingUserId);
        if (!selectable.some((t) => t.id === adminTokenId)) {
          throw new OAuthError('invalid_request', 'You can only map an admin token you own');
        }
      }
      if ((client.adminTokenId ?? null) !== adminTokenId) {
        await strapi.db.query(UID.client).update({ where: { id }, data: { adminTokenId } });
        await this.revokeClientGrants(client.clientId);
      }
      return { id, adminTokenId };
    },

    /** Drop sessions backed by an admin token that no longer exists (deleted in Settings or with its owner). */
    async removeGrantsForAdminToken(adminTokenId: number) {
      const { count } = await strapi.db.query(UID.grant).deleteMany({ where: { adminTokenId } });
      if (count) {
        strapi.log.info(`[${PLUGIN_ID}] Ended ${count} MCP session(s) because admin token ${adminTokenId} was deleted`);
      }
      return count;
    },

    /** Revoke every session a user approved. Returns how many were revoked. */
    async revokeUserGrants(adminUserId: number) {
      const grants = await strapi.db.query(UID.grant).findMany({ where: { adminUserId }, select: ['id'] });
      for (const grant of grants) {
        await this.revokeGrant(grant.id);
      }
      return grants.length;
    },

    /** Admin tokens the user may attach to a session: their own, unexpired, not minted by this plugin. */
    async listSelectableTokens(userId: number): Promise<SelectableToken[]> {
      const tokens = await strapi.db.query('admin::api-token').findMany({
        where: { kind: 'admin', adminUserOwner: { id: userId } },
        select: ['id', 'name', 'description', 'expiresAt', 'encryptedKey'],
        orderBy: { name: 'asc' },
      });
      const now = Date.now();
      return tokens
        .filter((t: any) => t.encryptedKey && !t.name.startsWith(MINTED_TOKEN_PREFIX))
        .filter((t: any) => !t.expiresAt || new Date(t.expiresAt).getTime() > now)
        .map((t: any) => ({ id: t.id, name: t.name, description: t.description, expiresAt: t.expiresAt }));
    },

    async listGrants() {
      const grants = await strapi.db.query(UID.grant).findMany({
        select: ['id', 'clientId', 'adminUserId', 'adminTokenId', 'ownsAdminToken', 'scope', 'expiresAt', 'refreshExpiresAt', 'lastUsedAt', 'createdAt'],
        orderBy: { createdAt: 'desc' },
      });
      const clientIds = [...new Set(grants.map((g: any) => g.clientId))];
      const userIds = [...new Set(grants.map((g: any) => g.adminUserId))];
      const tokenIds = [...new Set(grants.map((g: any) => g.adminTokenId))];
      const [clients, users, tokens] = await Promise.all([
        strapi.db.query(UID.client).findMany({ where: { clientId: { $in: clientIds } }, select: ['clientId', 'name'] }),
        strapi.db.query('admin::user').findMany({ where: { id: { $in: userIds } }, select: ['id', 'email', 'isActive', 'blocked'] }),
        strapi.db.query('admin::api-token').findMany({ where: { id: { $in: tokenIds } }, select: ['id', 'name'] }),
      ]);
      const clientNames = new Map(clients.map((c: any) => [c.clientId, c.name]));
      const usersById = new Map(users.map((u: any) => [u.id, u]));
      const tokenNames = new Map(tokens.map((t: any) => [t.id, t.name]));
      const orphaned = grants.filter((g: any) => !tokenNames.has(g.adminTokenId));
      for (const grant of orphaned) {
        await this.removeGrantsForAdminToken(grant.adminTokenId);
      }
      return grants.filter((g: any) => tokenNames.has(g.adminTokenId)).map((g: any) => {
        const user: any = usersById.get(g.adminUserId);
        return {
          ...g,
          clientName: clientNames.get(g.clientId) ?? g.clientId,
          userEmail: user?.email ?? null,
          userActive: Boolean(user && user.isActive === true && user.blocked !== true),
          tokenName: g.ownsAdminToken ? null : tokenNames.get(g.adminTokenId) ?? null,
        };
      });
    },

    async listClients() {
      const clients = await strapi.db.query(UID.client).findMany({
        select: ['id', 'documentId', 'name', 'clientId', 'redirectUris', 'tokenEndpointAuthMethod', 'registrationType', 'adminTokenId', 'active', 'createdAt'],
        orderBy: { createdAt: 'desc' },
      });
      const tokenIds = clients.map((c: any) => c.adminTokenId).filter(Boolean);
      const tokens = tokenIds.length
        ? await strapi.db.query('admin::api-token').findMany({
            where: { id: { $in: tokenIds } },
            select: ['id', 'name'],
            populate: { adminUserOwner: { select: ['id', 'email'] } },
          })
        : [];
      const tokensById = new Map(tokens.map((t: any) => [t.id, t]));
      return clients.map((c: any) => {
        const token: any = c.adminTokenId ? tokensById.get(c.adminTokenId) : null;
        return {
          ...c,
          redirectUris: normalizeRedirectUris(c.redirectUris),
          adminToken: c.adminTokenId
            ? token
              ? { id: token.id, name: token.name, ownerId: token.adminUserOwner?.id ?? null, ownerEmail: token.adminUserOwner?.email ?? null }
              : { id: c.adminTokenId, name: null, ownerId: null, ownerEmail: null, missing: true }
            : null,
        };
      });
    },

    /** Create a client from the admin panel. The secret is returned once and never shown again. */
    async createClient(input: { name: string; redirectUris: string[]; confidential: boolean; adminTokenId?: number | null; actingUserId: number }) {
      if (input.adminTokenId) {
        const selectable = await this.listSelectableTokens(input.actingUserId);
        if (!selectable.some((t) => t.id === input.adminTokenId)) {
          throw new OAuthError('invalid_request', 'You can only map an admin token you own');
        }
      }
      const clientId = generateToken(TOKEN_PREFIX.clientId, 16);
      const clientSecret = input.confidential ? generateToken(TOKEN_PREFIX.clientSecret) : null;
      const row = await strapi.db.query(UID.client).create({
        data: {
          name: input.name.slice(0, 100),
          clientId,
          clientSecret,
          redirectUris: input.redirectUris,
          tokenEndpointAuthMethod: input.confidential ? 'client_secret_post' : 'none',
          registrationType: 'manual',
          adminTokenId: input.adminTokenId ?? null,
          active: true,
        },
      });
      return { id: row.id, clientId, clientSecret };
    },

    async setClientActive(id: number, active: boolean) {
      const client = await strapi.db.query(UID.client).update({ where: { id }, data: { active } });
      if (client && !active) {
        await this.revokeClientGrants(client.clientId);
      }
      return client;
    },

    async deleteClient(id: number) {
      const client = await strapi.db.query(UID.client).findOne({ where: { id } });
      if (!client) {
        return false;
      }
      await this.revokeClientGrants(client.clientId);
      await strapi.db.query(UID.code).deleteMany({ where: { clientId: client.clientId } });
      await strapi.db.query(UID.client).delete({ where: { id } });
      return true;
    },

    /** Revoke every grant a client holds. Returns how many were revoked. */
    async revokeClientGrants(clientId: string) {
      const grants = await strapi.db.query(UID.grant).findMany({ where: { clientId }, select: ['id'] });
      for (const grant of grants) {
        await this.revokeGrant(grant.id);
      }
      return grants.length;
    },

    async cleanupExpired() {
      const now = new Date().toISOString();
      const { count: codes } = await strapi.db.query(UID.code).deleteMany({ where: { expiresAt: { $lt: now } } });
      const expiredGrants = await strapi.db
        .query(UID.grant)
        .findMany({ where: { refreshExpiresAt: { $lt: now } }, select: ['id'] });
      for (const grant of expiredGrants) {
        await this.revokeGrant(grant.id);
      }

      // Self-registered clients pile up (many MCP clients register on every new connection).
      // Drop ones that have held no grant for a full refresh-token lifetime.
      const staleBefore = new Date(Date.now() - config().refreshTokenTtl * 1000).toISOString();
      const staleClients = await strapi.db.query(UID.client).findMany({
        where: { registrationType: 'dynamic', createdAt: { $lt: staleBefore } },
        select: ['id', 'clientId'],
      });
      let clients = 0;
      for (const client of staleClients) {
        const grantCount = await strapi.db.query(UID.grant).count({ where: { clientId: client.clientId } });
        if (grantCount === 0) {
          await strapi.db.query(UID.client).delete({ where: { id: client.id } });
          clients += 1;
        }
      }

      return { codes, grants: expiredGrants.length, clients };
    },
  };
};

export type OAuthService = ReturnType<typeof oauthService>;

export default oauthService;
