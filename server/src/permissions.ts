import type { Core } from '@strapi/strapi';
import { PLUGIN_ID } from './pluginId';

export const MANAGE_ACTION = `plugin::${PLUGIN_ID}.manage`;

export const registerPermissions = async (strapi: Core.Strapi) => {
  await (strapi.service('admin::permission') as any).actionProvider.registerMany([
    {
      section: 'plugins',
      displayName: 'Manage MCP OAuth clients and grants',
      uid: 'manage',
      pluginName: PLUGIN_ID,
    },
  ]);
};
