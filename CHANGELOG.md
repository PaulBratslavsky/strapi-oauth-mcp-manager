# Changelog

## 1.1.0

Customer sign-in with LINE, for apps that expose MCP tools to their own users.

### Added

- Token exchange (RFC 8693) at the token endpoint: a LINE client posts a customer's LINE ID token (`liff.getIDToken()`) and gets a short-lived MCP session. The session runs with the client's mapped admin token.
- `resolveSubject(authorization)` on the `oauth` service. Tool plugins pass the `Authorization` header their handler received and get the customer's `line:U…` subject, or `null` for staff sessions, plain admin tokens and anything invalid.
- Configuration: `identityProviders.line.channelId`, the test-only `identityProviders.line.verifyUrl`, and `endUserAccessTokenTtl` (default 3600 seconds).
- "Customer sign-in" when adding a client on the **MCP OAuth** page, a Customer column in the sessions list (masked), and token exchange details under Connection details.
- Discovery lists the token exchange grant when LINE sign-in is configured.

### Changed

- New fields: `endUserProvider` on clients (existing clients are staff clients), and `subject` on grants.
- LINE clients are always public, must keep a mapped admin token, and may have no redirect URI.
- Customer sessions have no refresh token. They expire after `endUserAccessTokenTtl`, and the app exchanges a fresh ID token.

### Breaking changes

None. Staff sign-in, dynamic client registration, refresh rotation and revocation work as before.

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
