# Changelog

## 1.0.0

A rewrite that adds OAuth sign-in to the MCP server built into Strapi 5.47+ (`/mcp`).

### Added

- OAuth 2.1 authorization server for `/mcp`: protected resource metadata (RFC 9728), authorization server metadata (RFC 8414), dynamic client registration (RFC 7591), PKCE with S256 (RFC 7636), token revocation (RFC 7009) and refresh token rotation.
- Consent page where users sign in with their Strapi admin account and pick one of their own admin tokens. Each session gets exactly that token's permissions.
- Optional admin token mapping per client. A mapped client always uses its token, and only the token's owner can approve it.
- Optional "All of my permissions" access, behind `allowUserPermissions` (off by default).
- Revocation at every level: deactivating a user, deleting or regenerating a token, revoking a session, revoking all sessions for a user, turning off a client, or changing a client's mapped token.
- **MCP OAuth** admin page with connection details, connected sessions and client management, gated by the new **Manage MCP OAuth clients and grants** permission.
- Plugin configuration: `accessTokenTtl`, `refreshTokenTtl`, `authorizationCodeTtl`, `refreshTokenReuseWindow`, `dynamicClientRegistration`, `allowUserPermissions` and `cleanupIntervalMs`.
- Refresh token reuse detection: a rotated refresh token used again after `refreshTokenReuseWindow` (10 seconds) revokes the session. Rotation is atomic, so concurrent refreshes with one token can't both succeed.
- Warning when OAuth is served over plain `http` on a host other than `localhost`.
- Confirmation before deleting a client or revoking all of a user's sessions, and an error state with retry when the admin page can't load.
- End-to-end test suites (`npm run test:e2e`).

### Changed

- Discovery documents moved to the server root (`/.well-known/...`).
- OAuth codes and tokens are stored only as SHA-256 hashes.
- The OAuth client content type is no longer shown in the Content Manager.

### Breaking changes

- Requires Strapi 5.47.0 or later with `server.mcp.enabled: true`.
- Only `/mcp` is protected. Routes matching `/api/*/mcp` are no longer handled.
- The OAuth client, code and token tables changed. Existing tokens stop working, and clients reconnect through the consent page.
- The `strapiApiToken` field on clients is removed. Map an admin token to the client instead.
- The `/api/strapi-oauth-mcp-manager/.well-known/*` routes are removed.
