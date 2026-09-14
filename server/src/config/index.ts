export interface PluginConfig {
  /** Lifetime of an OAuth access token, in seconds. */
  accessTokenTtl: number;
  /** Lifetime of a refresh token (and of the admin token behind the grant), in seconds. */
  refreshTokenTtl: number;
  /** Lifetime of an authorization code, in seconds. */
  authorizationCodeTtl: number;
  /** Allow MCP clients to register themselves (RFC 7591). Claude and ChatGPT rely on this. */
  dynamicClientRegistration: boolean;
  /** How often expired codes and grants are cleaned up, in milliseconds. 0 disables it. */
  cleanupIntervalMs: number;
  /**
   * Offer "All of my permissions" on the consent page, which mints a session token
   * carrying the user's full admin permissions. Off by default: sessions use an admin
   * token the user picks.
   */
  allowUserPermissions: boolean;
}

export default {
  default: {
    accessTokenTtl: 60 * 60,
    refreshTokenTtl: 30 * 24 * 60 * 60,
    authorizationCodeTtl: 10 * 60,
    dynamicClientRegistration: true,
    cleanupIntervalMs: 60 * 60 * 1000,
    allowUserPermissions: false,
  } satisfies PluginConfig,
  validator(config: Partial<PluginConfig>) {
    for (const key of ['accessTokenTtl', 'refreshTokenTtl', 'authorizationCodeTtl', 'cleanupIntervalMs'] as const) {
      if (config[key] !== undefined && (typeof config[key] !== 'number' || config[key] < 0)) {
        throw new Error(`[strapi-oauth-mcp-manager] config.${key} must be a non-negative number`);
      }
    }
  },
};
