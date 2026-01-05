/**
 * Endpoint Registration Service
 *
 * Allows MCP plugins to register their endpoints for OAuth protection.
 */

import type { Core } from '@strapi/strapi';
import { PLUGIN_ID } from '../pluginId';

const PLUGIN_UID = `plugin::${PLUGIN_ID}` as const;

export interface EndpointRegistration {
  name: string;
  pluginId: string;
  path: string;
  description?: string;
}

const endpointService = ({ strapi }: { strapi: Core.Strapi }) => ({
  /**
   * Register an MCP endpoint for OAuth protection
   */
  async register(endpoint: EndpointRegistration): Promise<any> {
    // Check if endpoint already exists
    const existing = await strapi.documents(`${PLUGIN_UID}.mcp-endpoint`).findFirst({
      filters: { path: endpoint.path },
    });

    if (existing) {
      // Update existing endpoint
      return strapi.documents(`${PLUGIN_UID}.mcp-endpoint`).update({
        documentId: existing.documentId,
        data: {
          name: endpoint.name,
          pluginId: endpoint.pluginId,
          description: endpoint.description,
          active: true,
        } as any,
      });
    }

    // Create new endpoint
    return strapi.documents(`${PLUGIN_UID}.mcp-endpoint`).create({
      data: {
        name: endpoint.name,
        pluginId: endpoint.pluginId,
        path: endpoint.path,
        description: endpoint.description,
        active: true,
      },
    });
  },

  /**
   * Unregister an MCP endpoint
   */
  async unregister(path: string): Promise<boolean> {
    const endpoint = await strapi.documents(`${PLUGIN_UID}.mcp-endpoint`).findFirst({
      filters: { path },
    });

    if (!endpoint) {
      return false;
    }

    await strapi.documents(`${PLUGIN_UID}.mcp-endpoint`).update({
      documentId: endpoint.documentId,
      data: { active: false } as any,
    });

    return true;
  },

  /**
   * Get all registered endpoints
   */
  async getAll(activeOnly = true): Promise<any[]> {
    const filters = activeOnly ? { active: true } : {};
    return strapi.documents(`${PLUGIN_UID}.mcp-endpoint`).findMany({ filters });
  },

  /**
   * Get endpoints for a specific plugin
   */
  async getByPlugin(pluginId: string, activeOnly = true): Promise<any[]> {
    const filters: any = { pluginId };
    if (activeOnly) {
      filters.active = true;
    }
    return strapi.documents(`${PLUGIN_UID}.mcp-endpoint`).findMany({ filters });
  },

  /**
   * Check if a path is a protected endpoint
   */
  async isProtected(path: string): Promise<boolean> {
    const endpoints = await this.getAll(true);
    return endpoints.some((e: any) => path.includes(e.path));
  },
});

export default endpointService;
