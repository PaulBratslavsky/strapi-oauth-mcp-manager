/**
 * OAuth Service
 *
 * Provides OAuth token validation and management for MCP plugins.
 */

import type { Core } from '@strapi/strapi';
import { PLUGIN_ID } from '../pluginId';

const PLUGIN_UID = `plugin::${PLUGIN_ID}` as const;

export interface TokenValidationResult {
  valid: boolean;
  strapiApiToken?: string;
  clientId?: string;
  error?: string;
}

const oauthService = ({ strapi }: { strapi: Core.Strapi }) => ({
  /**
   * Validate an OAuth access token
   */
  async validateToken(accessToken: string): Promise<TokenValidationResult> {
    try {
      const tokenRecord = await strapi.documents(`${PLUGIN_UID}.mcp-oauth-token`).findFirst({
        filters: { accessToken, revoked: false },
      });

      if (!tokenRecord) {
        return { valid: false };
      }

      // Check expiration
      if (new Date(tokenRecord.expiresAt as string) < new Date()) {
        return { valid: false, error: 'Token expired' };
      }

      // Get the linked OAuth client
      const client = await strapi.documents(`${PLUGIN_UID}.mcp-oauth-client`).findFirst({
        filters: { clientId: tokenRecord.clientId as string },
      });

      if (!client) {
        return { valid: false, error: 'Client not found' };
      }

      return {
        valid: true,
        strapiApiToken: client.strapiApiToken as string,
        clientId: client.clientId as string,
      };
    } catch (error) {
      strapi.log.error(`[${PLUGIN_ID}] Error validating token`, { error });
      return { valid: false, error: 'Token validation failed' };
    }
  },

  /**
   * Revoke all tokens for a client
   */
  async revokeClientTokens(clientId: string): Promise<number> {
    const tokens = await strapi.documents(`${PLUGIN_UID}.mcp-oauth-token`).findMany({
      filters: { clientId, revoked: false },
    });

    for (const token of tokens) {
      await strapi.documents(`${PLUGIN_UID}.mcp-oauth-token`).update({
        documentId: token.documentId,
        data: { revoked: true } as any,
      });
    }

    return tokens.length;
  },

  /**
   * Clean up expired tokens and codes
   */
  async cleanupExpired(): Promise<{ tokens: number; codes: number }> {
    const now = new Date().toISOString();

    // Find and delete expired codes
    const expiredCodes = await strapi.documents(`${PLUGIN_UID}.mcp-oauth-code`).findMany({
      filters: { expiresAt: { $lt: now } },
    });

    for (const code of expiredCodes) {
      await strapi.documents(`${PLUGIN_UID}.mcp-oauth-code`).delete({
        documentId: code.documentId,
      });
    }

    // Find and delete expired tokens (both access and refresh expired)
    const expiredTokens = await strapi.documents(`${PLUGIN_UID}.mcp-oauth-token`).findMany({
      filters: { refreshExpiresAt: { $lt: now } },
    });

    for (const token of expiredTokens) {
      await strapi.documents(`${PLUGIN_UID}.mcp-oauth-token`).delete({
        documentId: token.documentId,
      });
    }

    return {
      tokens: expiredTokens.length,
      codes: expiredCodes.length,
    };
  },
});

export default oauthService;
