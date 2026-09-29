export interface LineProviderConfig {
  /** Channel ID of the LINE Login or LINE MINI App channel whose ID tokens are accepted. */
  channelId: string;
  /** For tests and local development only: where to verify ID tokens. Defaults to LINE's endpoint. */
  verifyUrl?: string;
}

export interface IdentityProvidersConfig {
  line?: LineProviderConfig;
}

export interface PluginConfig {
  /** Lifetime of an OAuth access token, in seconds. */
  accessTokenTtl: number;
  /** Lifetime of a refresh token (and of the admin token behind the grant), in seconds. */
  refreshTokenTtl: number;
  /** Lifetime of an authorization code, in seconds. */
  authorizationCodeTtl: number;
  /**
   * After a refresh token is rotated, how long a repeat use of the old one is treated as a
   * harmless retry (rejected, session kept). After this window, reusing it revokes the session.
   */
  refreshTokenReuseWindow: number;
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
  /** Identity providers whose ID tokens customers can exchange for an MCP session. Empty means off. */
  identityProviders: IdentityProvidersConfig;
  /** Lifetime of a customer session from token exchange, in seconds. There is no refresh token. */
  endUserAccessTokenTtl: number;
}

export default {
  default: {
    accessTokenTtl: 60 * 60,
    refreshTokenTtl: 30 * 24 * 60 * 60,
    authorizationCodeTtl: 10 * 60,
    refreshTokenReuseWindow: 10,
    dynamicClientRegistration: true,
    cleanupIntervalMs: 60 * 60 * 1000,
    allowUserPermissions: false,
    identityProviders: {},
    endUserAccessTokenTtl: 60 * 60,
  } satisfies PluginConfig,
  validator(config: Partial<PluginConfig>) {
    for (const key of ['accessTokenTtl', 'refreshTokenTtl', 'authorizationCodeTtl', 'refreshTokenReuseWindow', 'cleanupIntervalMs'] as const) {
      if (config[key] !== undefined && (typeof config[key] !== 'number' || config[key] < 0)) {
        throw new Error(`[strapi-oauth-mcp-manager] config.${key} must be a non-negative number`);
      }
    }
    if (
      config.endUserAccessTokenTtl !== undefined &&
      (!Number.isInteger(config.endUserAccessTokenTtl) || config.endUserAccessTokenTtl <= 0)
    ) {
      throw new Error('[strapi-oauth-mcp-manager] config.endUserAccessTokenTtl must be a positive whole number of seconds');
    }
    const providers = config.identityProviders as unknown;
    if (providers !== undefined) {
      if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) {
        throw new Error('[strapi-oauth-mcp-manager] config.identityProviders must be an object, e.g. { line: { channelId } }');
      }
      const unknownProviders = Object.keys(providers).filter((key) => key !== 'line');
      if (unknownProviders.length > 0) {
        throw new Error(`[strapi-oauth-mcp-manager] config.identityProviders only supports "line" (got ${unknownProviders.join(', ')})`);
      }
      const line = (providers as IdentityProvidersConfig).line as Partial<LineProviderConfig> | undefined;
      if (line !== undefined) {
        if (typeof line?.channelId !== 'string' || line.channelId.trim() === '') {
          throw new Error('[strapi-oauth-mcp-manager] config.identityProviders.line.channelId must be your LINE channel ID');
        }
        if (line.verifyUrl !== undefined && (typeof line.verifyUrl !== 'string' || !/^https?:\/\/\S+$/.test(line.verifyUrl))) {
          throw new Error('[strapi-oauth-mcp-manager] config.identityProviders.line.verifyUrl must be an http(s) URL');
        }
      }
    }
  },
};
