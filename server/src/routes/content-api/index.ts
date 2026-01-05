export default [
  // OAuth 2.0 Authorization Server Metadata (RFC 8414)
  {
    method: 'GET',
    path: '/.well-known/oauth-authorization-server',
    handler: 'oauth.discovery',
    config: {
      auth: false,
      policies: [],
    },
  },
  // OAuth 2.0 Protected Resource Metadata (RFC 9728)
  {
    method: 'GET',
    path: '/.well-known/oauth-protected-resource',
    handler: 'oauth.protectedResource',
    config: {
      auth: false,
      policies: [],
    },
  },
  // OAuth 2.0 Authorization Endpoint
  {
    method: 'GET',
    path: '/oauth/authorize',
    handler: 'oauth.authorize',
    config: {
      auth: false,
      policies: [],
    },
  },
  // OAuth 2.0 Token Endpoint
  {
    method: 'POST',
    path: '/oauth/token',
    handler: 'oauth.token',
    config: {
      auth: false,
      policies: [],
    },
  },
];
