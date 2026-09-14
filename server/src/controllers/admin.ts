import type { Core } from '@strapi/strapi';
import { PLUGIN_ID } from '../pluginId';
import type { PluginConfig } from '../config';
import { OAuthError, type OAuthService } from '../services/oauth';
import { getEndpoints, normalizeRedirectUris } from '../utils/url';

const adminController = ({ strapi }: { strapi: Core.Strapi }) => {
  const service = (): OAuthService => strapi.plugin(PLUGIN_ID).service('oauth');

  return {
    async overview(ctx: any) {
      const config = strapi.config.get(`plugin::${PLUGIN_ID}`) as PluginConfig;
      const endpoints = getEndpoints(ctx, strapi);
      ctx.body = {
        data: {
          mcpEnabled: Boolean(strapi.ai?.mcp?.isEnabled?.()),
          encryptionKeyConfigured: Boolean(strapi.config.get('admin.secrets.encryptionKey')),
          dynamicClientRegistration: config.dynamicClientRegistration,
          allowUserPermissions: config.allowUserPermissions,
          endpoints,
        },
      };
    },

    async listGrants(ctx: any) {
      ctx.body = { data: await service().listGrants() };
    },

    async revokeGrant(ctx: any) {
      const revoked = await service().revokeGrant(Number(ctx.params.id));
      if (!revoked) {
        return ctx.notFound('Grant not found');
      }
      ctx.body = { data: { revoked: true } };
    },

    async revokeUserGrants(ctx: any) {
      ctx.body = { data: { revoked: await service().revokeUserGrants(Number(ctx.params.userId)) } };
    },

    async listClients(ctx: any) {
      ctx.body = { data: await service().listClients() };
    },

    async createClient(ctx: any) {
      const body = ctx.request.body ?? {};
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const redirectUris = normalizeRedirectUris(body.redirectUris)
        .map((uri) => uri.trim())
        .filter(Boolean);
      if (!name) {
        return ctx.badRequest('name is required');
      }
      if (redirectUris.length === 0) {
        return ctx.badRequest('At least one redirect URI is required');
      }
      const invalid = redirectUris.find((uri) => {
        try {
          new URL(uri.replace(/\*/g, 'x'));
          return false;
        } catch {
          return true;
        }
      });
      if (invalid) {
        return ctx.badRequest(`Invalid redirect URI: ${invalid}`);
      }
      const adminTokenId = body.adminTokenId ? Number(body.adminTokenId) : null;
      try {
        ctx.status = 201;
        ctx.body = {
          data: await service().createClient({
            name,
            redirectUris,
            confidential: body.confidential !== false,
            adminTokenId,
            actingUserId: ctx.state.user.id,
          }),
        };
      } catch (error) {
        if (error instanceof OAuthError) {
          return ctx.badRequest(error.description);
        }
        throw error;
      }
    },

    /** Tokens the signed-in admin can map to a client: their own unexpired admin tokens. */
    async listTokens(ctx: any) {
      ctx.body = { data: await service().listSelectableTokens(ctx.state.user.id) };
    },

    async updateClient(ctx: any) {
      const body = ctx.request.body ?? {};
      const id = Number(ctx.params.id);
      const result: Record<string, unknown> = { id };

      if ('adminTokenId' in body) {
        const adminTokenId = body.adminTokenId === null || body.adminTokenId === '' ? null : Number(body.adminTokenId);
        try {
          const updated = await service().setClientToken(id, adminTokenId, ctx.state.user.id);
          if (!updated) {
            return ctx.notFound('Client not found');
          }
          result.adminTokenId = updated.adminTokenId;
        } catch (error) {
          if (error instanceof OAuthError) {
            return ctx.badRequest(error.description);
          }
          throw error;
        }
      }

      if ('active' in body) {
        if (typeof body.active !== 'boolean') {
          return ctx.badRequest('active must be a boolean');
        }
        const client = await service().setClientActive(id, body.active);
        if (!client) {
          return ctx.notFound('Client not found');
        }
        result.active = client.active;
      }

      ctx.body = { data: result };
    },

    async deleteClient(ctx: any) {
      if (!(await service().deleteClient(Number(ctx.params.id)))) {
        return ctx.notFound('Client not found');
      }
      ctx.body = { data: { deleted: true } };
    },
  };
};

export default adminController;
