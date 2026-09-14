import { MANAGE_ACTION } from '../../permissions';

const adminRoute = (method: string, path: string, handler: string) => ({
  method,
  path,
  handler,
  config: {
    policies: ['admin::isAuthenticatedAdmin', { name: 'admin::hasPermissions', config: { actions: [MANAGE_ACTION] } }],
  },
});

export default [
  adminRoute('GET', '/overview', 'admin.overview'),
  adminRoute('GET', '/grants', 'admin.listGrants'),
  adminRoute('DELETE', '/grants/:id', 'admin.revokeGrant'),
  adminRoute('DELETE', '/users/:userId/grants', 'admin.revokeUserGrants'),
  adminRoute('GET', '/tokens', 'admin.listTokens'),
  adminRoute('GET', '/clients', 'admin.listClients'),
  adminRoute('POST', '/clients', 'admin.createClient'),
  adminRoute('PUT', '/clients/:id', 'admin.updateClient'),
  adminRoute('DELETE', '/clients/:id', 'admin.deleteClient'),
];
