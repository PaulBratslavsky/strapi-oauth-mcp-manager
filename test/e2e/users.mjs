// Several admin users with different roles, each connecting with their own tokens,
// and offboarding a user by deactivating their account.
import { ADMIN_PASSWORD, BASE, adminSession, authorize, callTool, check, contentPermission, exchangeCode, finish, mcp, registerClient, pkce, toolNames } from './helpers.mjs';

const REDIRECT = 'http://localhost:33418/callback';
const PASSWORD = 'E2eUser123!';
const superAdmin = await adminSession();

const roles = (await superAdmin.call('GET', '/admin/roles')).body.data;
const roleId = (code) => roles.find((r) => r.code === code).id;

const ensureUser = async (email, roleCode) => {
  const existing = (await superAdmin.call('GET', `/admin/users?filters[email][$eq]=${encodeURIComponent(email)}`)).body.data.results[0];
  if (existing) {
    await superAdmin.call('PUT', `/admin/users/${existing.id}`, { roles: [roleId(roleCode)], isActive: true });
    return existing;
  }
  const created = (await superAdmin.call('POST', '/admin/users', { firstname: 'E2E', lastname: roleCode, email, roles: [roleId(roleCode)] })).body.data;
  await fetch(`${BASE}/admin/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ registrationToken: created.registrationToken, userInfo: { firstname: 'E2E', lastname: roleCode, password: PASSWORD } }),
  });
  return created;
};

// Users need the Admin Tokens permissions to create their own tokens. Grant them to the
// Editor and Author roles for this test, and put the roles back afterwards.
const TOKEN_ACTIONS = ['access', 'create', 'read', 'update', 'regenerate', 'delete'].map((a) => `admin::admin-tokens.${a}`);
const originalRolePermissions = {};
const toPermissionInput = (p) => ({ action: p.action, subject: p.subject ?? null, properties: p.properties ?? {}, conditions: p.conditions ?? [] });
for (const code of ['strapi-editor', 'strapi-author']) {
  const id = roleId(code);
  const current = (await superAdmin.call('GET', `/admin/roles/${id}/permissions`)).body.data.map(toPermissionInput);
  // Default roles have no Admin Tokens permissions, so restoring means removing them again.
  originalRolePermissions[id] = current.filter((p) => !TOKEN_ACTIONS.includes(p.action));
  const extra = TOKEN_ACTIONS.filter((action) => !current.some((p) => p.action === action)).map((action) => toPermissionInput({ action }));
  const r = await superAdmin.call('PUT', `/admin/roles/${id}/permissions`, { permissions: [...current, ...extra] });
  if (r.status !== 200) throw new Error(`Could not update role ${code}: ${JSON.stringify(r.body)}`);
}

const editorUser = await ensureUser('e2e-editor@example.com', 'strapi-editor');
const authorUser = await ensureUser('e2e-author@example.com', 'strapi-author');
const editor = await adminSession('e2e-editor@example.com', PASSWORD);
const author = await adminSession('e2e-author@example.com', PASSWORD);

const reg = (await registerClient({ client_name: 'E2E multi-user', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' })).body;
const connect = async (email, password, tokenId) => {
  const { verifier, challenge } = pkce();
  const authParams = { response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' };
  const flow = await authorize({ authParams, email, password, access: `token:${tokenId}` });
  return { flow, tokens: (await exchangeCode({ code: flow.code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier })).body };
};

// Each user creates their own token
const editorToken = await editor.createAdminToken('E2E editor publish', ['read', 'update', 'publish'].map(contentPermission));
const authorToken = await author.createAdminToken('E2E author write', ['read', 'create', 'update'].map(contentPermission));
const superToken = await superAdmin.createAdminToken('E2E super read', [contentPermission('read')]);

// An author cannot mint a token above their role
const tooMuch = await author.call('POST', '/admin/admin-tokens', { name: 'E2E author publish', lifespan: null, adminPermissions: [contentPermission('publish')] });
check('core refuses a token that exceeds the owner\'s role', tooMuch.status >= 400, String(tooMuch.status));

// The picker only shows the signed-in user's tokens
const authorPicker = await connect('e2e-author@example.com', PASSWORD, authorToken.id);
check('author sees only their own tokens', authorPicker.flow.tokenIds.includes(authorToken.id) && !authorPicker.flow.tokenIds.includes(editorToken.id) && !authorPicker.flow.tokenIds.includes(superToken.id));
const stolen = await connect('e2e-author@example.com', PASSWORD, superToken.id);
check('author cannot pick the super admin\'s token', !stolen.flow.code);

const authorSession = authorPicker.tokens;
const editorSession = (await connect('e2e-editor@example.com', PASSWORD, editorToken.id)).tokens;
const superSession = (await connect(undefined, ADMIN_PASSWORD, superToken.id)).tokens;

const authorTools = await toolNames(authorSession.access_token);
const editorTools = await toolNames(editorSession.access_token);
const superTools = await toolNames(superSession.access_token);
check('author session: create but no publish', authorTools.includes('create_article') && !authorTools.includes('publish_article'), authorTools.join(', '));
check('editor session: publish but no create', editorTools.includes('publish_article') && !editorTools.includes('create_article'), editorTools.join(', '));
check('super admin session with a read token is read-only', superTools.includes('list_article') && !superTools.includes('update_article'), superTools.join(', '));

// Row-level conditions from the author role still apply
const created = await callTool(authorSession.access_token, 'create_article', { data: { title: 'Author draft' } });
check('author creates an article', created.ok);
const superDoc = (await superAdmin.call('POST', '/content-manager/collection-types/api::article.article', { title: 'Super admin article' })).body?.data?.documentId;
check('author cannot update someone else\'s article', !!superDoc && !(await callTool(authorSession.access_token, 'update_article', { documentId: superDoc, data: { title: 'x' } })).ok);

// Offboarding: deactivate the editor → their sessions stop; others keep working
await superAdmin.call('PUT', `/admin/users/${editorUser.id}`, { isActive: false });
check('deactivating a user ends their sessions', (await mcp(editorSession.access_token, 'tools/list')).status === 401);
check('other users keep working', (await mcp(authorSession.access_token, 'tools/list')).status === 200);
const blocked = await connect('e2e-editor@example.com', PASSWORD, editorToken.id);
check('a deactivated user cannot sign in on the consent page', !blocked.flow.code && blocked.flow.response.status === 401);

// Reactivate and clean up
await superAdmin.call('PUT', `/admin/users/${editorUser.id}`, { isActive: true });
await superAdmin.call('DELETE', `/admin/admin-tokens/${superToken.id}`);
await superAdmin.call('DELETE', `/admin/admin-tokens/${authorToken.id}`);
await superAdmin.call('DELETE', `/admin/admin-tokens/${editorToken.id}`);
for (const [id, permissions] of Object.entries(originalRolePermissions)) {
  await superAdmin.call('PUT', `/admin/roles/${id}/permissions`, { permissions });
}
void authorUser;
finish();
