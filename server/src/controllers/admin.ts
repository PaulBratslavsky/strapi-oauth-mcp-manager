import type { Core } from '@strapi/strapi';
import { PLUGIN_ID } from '../pluginId';
import type { PluginConfig } from '../config';
import type { OAuthService } from '../services/oauth';
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
      ctx.status = 201;
      ctx.body = { data: await service().createClient({ name, redirectUris, confidential: body.confidential !== false }) };
    },

    async updateClient(ctx: any) {
      const active = ctx.request.body?.active;
      if (typeof active !== 'boolean') {
        return ctx.badRequest('active must be a boolean');
      }
      const client = await service().setClientActive(Number(ctx.params.id), active);
      if (!client) {
        return ctx.notFound('Client not found');
      }
      ctx.body = { data: { id: client.id, active: client.active } };
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
