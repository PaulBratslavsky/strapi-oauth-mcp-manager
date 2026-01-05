import type { Core } from '@strapi/strapi';
import mcpOauthMiddleware from './middlewares/mcp-oauth';
import { PLUGIN_ID } from './pluginId';

const bootstrap = async ({ strapi }: { strapi: Core.Strapi }) => {
  // Register the OAuth middleware globally to protect MCP endpoints
  const middleware = mcpOauthMiddleware({}, { strapi });
  strapi.server.use(middleware);

  strapi.log.info(`[${PLUGIN_ID}] OAuth middleware registered`);
  strapi.log.info(`[${PLUGIN_ID}] OAuth endpoints available at: /api/${PLUGIN_ID}/oauth/*`);
  strapi.log.info(`[${PLUGIN_ID}] Discovery: /api/${PLUGIN_ID}/.well-known/oauth-authorization-server`);
};

export default bootstrap;
