# Strapi OAuth MCP Manager

Centralized OAuth 2.0 authentication manager for Strapi MCP (Model Context Protocol) plugins. Enables ChatGPT, Claude, and other AI assistants to securely authenticate with your Strapi MCP endpoints.

## Features

- **Centralized OAuth 2.0** - Single authentication layer for all MCP plugins
- **RFC Compliant** - Implements RFC 6749, RFC 8414, and RFC 9728
- **Dual Authentication** - Supports both OAuth tokens and Strapi API tokens
- **ChatGPT Ready** - Works with ChatGPT's MCP integration out of the box
- **Claude Compatible** - Supports direct API token authentication
- **Admin Management** - Manage OAuth clients through Strapi admin panel
- **Wildcard Redirects** - Supports wildcard patterns in redirect URIs

## Installation

```bash
npm install strapi-oauth-mcp-manager
```

## Configuration

Add the plugin to your `config/plugins.ts`:

```typescript
export default () => ({
  'strapi-oauth-mcp-manager': {
    enabled: true,
  },
  // Your other MCP plugins...
  'yt-transcript-strapi-plugin': {
    enabled: true,
  },
});
```

## How It Works

### For MCP Plugin Developers

MCP plugins register with the OAuth manager to gain authentication support:

```typescript
// In your plugin's bootstrap.ts
const oauthPlugin = strapi.plugin('strapi-oauth-mcp-manager');

if (oauthPlugin) {
  await oauthPlugin.service('endpoint').register({
    name: 'My MCP Plugin',
    pluginId: 'my-mcp-plugin',
    path: '/api/my-mcp-plugin/mcp',
    description: 'MCP endpoint for my tools',
  });
}
```

### For Users

1. **Create an OAuth Client** in Strapi Admin:
   - Go to Content Manager > MCP OAuth Client
   - Add client name, ID, secret, and redirect URIs
   - Link to a Strapi API token

2. **Configure ChatGPT**:
   - MCP Server URL: `https://your-domain/api/your-mcp-plugin/mcp`
   - OAuth Client ID: From Strapi admin
   - OAuth Client Secret: From Strapi admin

## OAuth Endpoints

| Endpoint | URL |
|----------|-----|
| Authorization | `/api/strapi-oauth-mcp-manager/oauth/authorize` |
| Token | `/api/strapi-oauth-mcp-manager/oauth/token` |
| Discovery (RFC 8414) | `/api/strapi-oauth-mcp-manager/.well-known/oauth-authorization-server` |
| Protected Resource (RFC 9728) | `/api/strapi-oauth-mcp-manager/.well-known/oauth-protected-resource` |

## Content Types

The plugin creates these content types:

| Content Type | Purpose |
|--------------|---------|
| `mcp-oauth-client` | OAuth client configurations |
| `mcp-oauth-code` | Authorization codes (temporary) |
| `mcp-oauth-token` | Access and refresh tokens |
| `mcp-endpoint` | Registered MCP endpoints |

## Creating an OAuth Client for ChatGPT

In Strapi Admin > Content Manager > MCP OAuth Client:

```json
{
  "name": "ChatGPT",
  "clientId": "chatgpt",
  "clientSecret": "your-secure-secret",
  "redirectUris": ["https://chatgpt.com/connector_platform_oauth_redirect"],
  "strapiApiToken": "your-strapi-api-token",
  "active": true
}
```

## Authentication Flow

```
1. Client hits MCP endpoint without auth
2. Returns 401 with WWW-Authenticate header
3. Client discovers OAuth endpoints via .well-known
4. Client completes OAuth authorization code flow
5. Client receives access token
6. Client makes MCP requests with Bearer token
7. OAuth manager validates and forwards to MCP plugin
```

## Claude Desktop (API Token)

For Claude Desktop, use direct Strapi API tokens:

```json
{
  "mcpServers": {
    "your-mcp": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://your-domain/api/your-mcp-plugin/mcp",
        "--header",
        "Authorization: Bearer YOUR_STRAPI_API_TOKEN"
      ]
    }
  }
}
```

## Requirements

- Strapi v5.x
- Node.js >= 18

## License

MIT
# strapi-oauth-mcp-manager
