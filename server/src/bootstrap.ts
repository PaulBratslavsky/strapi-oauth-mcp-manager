import type { Core } from '@strapi/strapi';
import mcpOauthMiddleware from './middlewares/mcp-oauth';
import { PLUGIN_ID } from './pluginId';
import type { PluginConfig } from './config';
import type { OAuthService } from './services/oauth';
import { MCP_PATH, isInsecureOrigin } from './utils/url';

let cleanupTimer: NodeJS.Timeout | undefined;

const bootstrap = async ({ strapi }: { strapi: Core.Strapi }) => {
  if (!strapi.ai?.mcp?.isEnabled?.()) {
    strapi.log.warn(
      `[${PLUGIN_ID}] Strapi's MCP server is disabled. Set server.mcp.enabled = true (Strapi 5.47+) to use MCP OAuth.`
    );
  }
  if (!strapi.config.get('admin.secrets.encryptionKey')) {
    strapi.log.warn(
      `[${PLUGIN_ID}] admin.secrets.encryptionKey is not set. OAuth grants can't be issued until it is (ENCRYPTION_KEY).`
    );
  }

  const serverUrl = strapi.config.get('server.url') as string | undefined;
  if (serverUrl && isInsecureOrigin(serverUrl)) {
    strapi.log.warn(
      `[${PLUGIN_ID}] server.url is ${serverUrl}. MCP OAuth over plain http outside localhost exposes codes and tokens; use https.`
    );
  }

  // Runs after the global middlewares (so the body is parsed) and before the router
  // mounts core's /mcp route.
  strapi.server.use(mcpOauthMiddleware({}, { strapi }));

  // Discovery documents live at the server root, outside the /api prefix.
  const controller = strapi.plugin(PLUGIN_ID).controller('oauth') as Record<string, (ctx: any) => Promise<void>>;
  const discoveryRoute = (path: string, action: string) => ({
    method: 'GET',
    path,
    handler: (ctx: any) => controller[action](ctx),
    config: { auth: false },
  });
  strapi.server.routes([
    discoveryRoute(`/.well-known/oauth-protected-resource${MCP_PATH}`, 'protectedResource'),
    discoveryRoute('/.well-known/oauth-protected-resource', 'protectedResource'),
    discoveryRoute('/.well-known/oauth-authorization-server', 'authorizationServer'),
  ] as any);

  const service: OAuthService = strapi.plugin(PLUGIN_ID).service('oauth');

  // End sessions as soon as their admin token is deleted, whether someone deletes it in
  // Settings → Admin Tokens or Strapi removes it along with its owner.
  strapi.db.lifecycles.subscribe({
    models: ['admin::api-token'],
    async afterDelete(event: any) {
      const id = event.result?.id;
      if (id) {
        await service.removeGrantsForAdminToken(id).catch((error) =>
          strapi.log.error(`[${PLUGIN_ID}] Could not end sessions for admin token ${id}: ${error.message}`)
        );
      }
    },
  } as any);
  const { cleanupIntervalMs } = strapi.config.get(`plugin::${PLUGIN_ID}`) as PluginConfig;
  if (cleanupIntervalMs > 0) {
    const cleanup = () =>
      service
        .cleanupExpired()
        .then(({ codes, grants, clients }) => {
          if (codes || grants || clients) {
            strapi.log.info(
              `[${PLUGIN_ID}] Cleaned up ${codes} expired codes, ${grants} expired grants, ${clients} unused self-registered clients`
            );
          }
        })
        .catch((error) => strapi.log.error(`[${PLUGIN_ID}] Cleanup failed: ${error.message}`));
    cleanupTimer = setInterval(cleanup, cleanupIntervalMs);
    cleanupTimer.unref();
    void cleanup();
  }

  strapi.log.info(`[${PLUGIN_ID}] OAuth enabled for ${MCP_PATH}`);
};

export const stopCleanup = () => {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = undefined;
  }
};

export default bootstrap;
