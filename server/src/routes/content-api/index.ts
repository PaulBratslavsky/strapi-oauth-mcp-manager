// Mounted under /api/strapi-oauth-mcp-manager. The .well-known discovery documents
// must live at the server root, so bootstrap registers those separately.
const publicRoute = (method: string, path: string, handler: string) => ({
  method,
  path,
  handler,
  config: { auth: false, policies: [] },
});

export default [
  publicRoute('GET', '/oauth/authorize', 'oauth.authorize'),
  publicRoute('POST', '/oauth/authorize', 'oauth.authorizeSubmit'),
  publicRoute('POST', '/oauth/token', 'oauth.token'),
  publicRoute('POST', '/oauth/register', 'oauth.register'),
  publicRoute('POST', '/oauth/revoke', 'oauth.revoke'),
];
