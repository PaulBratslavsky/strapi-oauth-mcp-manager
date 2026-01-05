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
  'strapi-content-mcp': {
    enabled: true,
  },
});
```

---

## Quick Start: ChatGPT Setup

### Step 1: Create a Strapi API Token

1. Go to **Strapi Admin** → **Settings** → **API Tokens**
2. Click **Create new API Token**
3. Configure:
   - **Name**: `ChatGPT MCP Access`
   - **Token type**: `Full access` (or custom with specific permissions)
   - **Token duration**: `Unlimited` (recommended) or set expiry
4. Click **Save** and **copy the token** (you won't see it again)

### Step 2: Create an OAuth Client in Strapi

1. Go to **Strapi Admin** → **Content Manager** → **MCP OAuth Client**
2. Click **Create new entry**
3. Fill in the fields:

| Field | Value |
|-------|-------|
| **name** | `ChatGPT` |
| **clientId** | `chatgpt` |
| **clientSecret** | Choose a secure secret (e.g., `my-super-secret-key-123`) |
| **redirectUris** | `https://chatgpt.com/connector_platform_oauth_redirect` |
| **strapiApiToken** | Paste the API token from Step 1 |
| **active** | `true` |

4. Click **Save**

### Step 3: Configure ChatGPT

1. Go to [ChatGPT](https://chatgpt.com)
2. Click your profile → **Settings** → **Connected Apps** → **Add App**
3. Fill in the form:

| Field | Value |
|-------|-------|
| **Name** | `Your App Name` (e.g., "YT Transcripts") |
| **Description** | What the app does |
| **MCP Server URL** | `https://your-strapi-domain.com/api/yt-transcript-strapi-plugin/mcp` |
| **Authentication** | `OAuth` |
| **Client ID** | `chatgpt` (from Step 2) |
| **Client Secret** | Your secret from Step 2 |

4. Click **Save**

### Step 4: Authorize

When you first use the MCP tools in ChatGPT, it will redirect you to Strapi to authorize. Click **Authorize** to complete the OAuth flow.

---

## Quick Start: Claude Desktop Setup

Claude Desktop uses direct Strapi API tokens (no OAuth flow needed).

### Step 1: Create a Strapi API Token

Same as ChatGPT Step 1 above.

### Step 2: Configure Claude Desktop

Edit your Claude Desktop config file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "yt-transcript": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://your-strapi-domain.com/api/yt-transcript-strapi-plugin/mcp",
        "--header",
        "Authorization: Bearer YOUR_STRAPI_API_TOKEN"
      ]
    },
    "strapi-content": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://your-strapi-domain.com/api/strapi-content-mcp/mcp",
        "--header",
        "Authorization: Bearer YOUR_STRAPI_API_TOKEN"
      ]
    }
  }
}
```

Replace:
- `your-strapi-domain.com` with your actual Strapi URL
- `YOUR_STRAPI_API_TOKEN` with the token from Step 1

### Step 3: Restart Claude Desktop

Quit and reopen Claude Desktop to load the new configuration.

---

## How It Works

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Strapi Application                       │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │           strapi-oauth-mcp-manager                   │    │
│  │  ┌───────────────┐  ┌───────────────────────────┐   │    │
│  │  │ OAuth         │  │ Global Auth Middleware    │   │    │
│  │  │ Endpoints     │  │ (protects all registered  │   │    │
│  │  │ /authorize    │  │  MCP endpoints)           │   │    │
│  │  │ /token        │  └───────────────────────────┘   │    │
│  │  └───────────────┘                                   │    │
│  └─────────────────────────────────────────────────────┘    │
│                            │                                 │
│         ┌──────────────────┼──────────────────┐             │
│         ▼                  ▼                  ▼             │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐       │
│  │ MCP Plugin  │   │ MCP Plugin  │   │ MCP Plugin  │       │
│  │     A       │   │     B       │   │     C       │       │
│  │ (registers) │   │ (registers) │   │ (registers) │       │
│  └─────────────┘   └─────────────┘   └─────────────┘       │
└─────────────────────────────────────────────────────────────┘
```

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

### Authentication Flow

```
ChatGPT/OAuth Client                    Strapi
       │                                   │
       │ 1. Request MCP endpoint           │
       │ ─────────────────────────────────>│
       │                                   │
       │ 2. 401 + WWW-Authenticate header  │
       │ <─────────────────────────────────│
       │                                   │
       │ 3. Discover OAuth via .well-known │
       │ ─────────────────────────────────>│
       │                                   │
       │ 4. Redirect to /authorize         │
       │ ─────────────────────────────────>│
       │                                   │
       │ 5. User authorizes, get code      │
       │ <─────────────────────────────────│
       │                                   │
       │ 6. Exchange code for token        │
       │ ─────────────────────────────────>│
       │                                   │
       │ 7. Access token returned          │
       │ <─────────────────────────────────│
       │                                   │
       │ 8. MCP requests with Bearer token │
       │ ─────────────────────────────────>│
       │                                   │
       │ 9. MCP response                   │
       │ <─────────────────────────────────│
```

---

## OAuth Endpoints

| Endpoint | URL |
|----------|-----|
| Authorization | `/api/strapi-oauth-mcp-manager/oauth/authorize` |
| Token | `/api/strapi-oauth-mcp-manager/oauth/token` |
| Discovery (RFC 8414) | `/api/strapi-oauth-mcp-manager/.well-known/oauth-authorization-server` |
| Protected Resource (RFC 9728) | `/api/strapi-oauth-mcp-manager/.well-known/oauth-protected-resource` |

---

## Content Types

The plugin creates these content types:

| Content Type | Purpose |
|--------------|---------|
| `mcp-oauth-client` | OAuth client configurations |
| `mcp-oauth-code` | Authorization codes (temporary) |
| `mcp-oauth-token` | Access and refresh tokens |
| `mcp-endpoint` | Registered MCP endpoints |

---

## OAuth Client Configuration

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Display name for the client |
| `clientId` | string | Unique identifier (e.g., `chatgpt`) |
| `clientSecret` | string | Secret for token exchange |
| `redirectUris` | string[] | Allowed redirect URIs after authorization |
| `strapiApiToken` | string | Strapi API token to use for authenticated requests |
| `active` | boolean | Whether the client is active |

### Redirect URIs

Common redirect URIs:

| Client | Redirect URI |
|--------|--------------|
| ChatGPT | `https://chatgpt.com/connector_platform_oauth_redirect` |
| Custom OAuth | Your app's callback URL |

Wildcard patterns are supported (e.g., `https://*.example.com/callback`).

---

## Troubleshooting

### "Invalid redirect_uri" Error

Make sure the redirect URI in your OAuth client exactly matches what the client sends. For ChatGPT, use:
```
https://chatgpt.com/connector_platform_oauth_redirect
```

### "Session expired" Error

Sessions expire after 4 hours. The client should automatically reinitialize the connection.

### Claude Desktop Not Connecting

1. Check that `mcp-remote` is installed: `npx mcp-remote --version`
2. Verify your API token is valid in Strapi Admin
3. Check the Strapi logs for authentication errors
4. Ensure your Strapi instance is accessible from your machine

### OAuth Flow Not Starting

1. Verify the OAuth client is set to `active: true`
2. Check that the `strapiApiToken` in the OAuth client is valid
3. Look at Strapi logs for detailed error messages

---

## Compatible MCP Plugins

These plugins support `strapi-oauth-mcp-manager`:

- [yt-transcript-strapi-plugin](https://www.npmjs.com/package/yt-transcript-strapi-plugin) - YouTube transcript tools
- [strapi-content-mcp](https://www.npmjs.com/package/strapi-content-mcp) - Strapi content management tools

---

## Requirements

- Strapi v5.x
- Node.js >= 18

## License

MIT
