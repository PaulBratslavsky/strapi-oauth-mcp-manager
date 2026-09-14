// Clients mapped to one admin token: the token is used for every session, and only its owner can approve.
import {
  BASE, PLUGIN, adminSession, authorize, check, contentPermission, exchangeCode, finish, mcp, toolNames,
} from './helpers.mjs';

const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const PASSWORD = 'E2eUser123!';
const admin = await adminSession();
const plugin = (method, path, body) => admin.call(method, `/${PLUGIN}${path}`, body);

// A second admin who must not be able to use the first admin's mapped client
const roles = (await admin.call('GET', '/admin/roles')).body.data;
const editorRole = roles.find((r) => r.code === 'strapi-editor').id;
const otherEmail = 'e2e-other@example.com';
let other = (await admin.call('GET', `/admin/users?filters[email][$eq]=${encodeURIComponent(otherEmail)}`)).body.data.results[0];
if (!other) {
  other = (await admin.call('POST', '/admin/users', { firstname: 'E2E', lastname: 'Other', email: otherEmail, roles: [editorRole] })).body.data;
  await fetch(`${BASE}/admin/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ registrationToken: other.registrationToken, userInfo: { firstname: 'E2E', lastname: 'Other', password: PASSWORD } }),
  });
}

const readToken = await admin.createAdminToken('E2E mapped read', [contentPermission('read')]);
const writeToken = await admin.createAdminToken('E2E mapped write', ['read', 'create', 'update'].map(contentPermission));

// The token list for mapping only contains the admin's own tokens
const mine = (await plugin('GET', '/tokens')).body.data;
check('mappable tokens include the admin\'s own tokens', mine.some((t) => t.id === readToken.id) && mine.some((t) => t.id === writeToken.id));

let res = await plugin('POST', '/clients', { name: 'E2E mapped ChatGPT', redirectUris: [REDIRECT], confidential: true, adminTokenId: readToken.id });
const client = res.body.data;
check('create a client mapped to a token', res.status === 201);
res = await plugin('POST', '/clients', { name: 'E2E bad mapping', redirectUris: [REDIRECT], adminTokenId: 999999 });
check('mapping a token you do not own is refused', res.status === 400);

const listed = (await plugin('GET', '/clients')).body.data.find((c) => c.clientId === client.clientId);
check('client list shows the mapped token and owner', listed.adminToken?.name === readToken.name && !!listed.adminToken?.ownerEmail);

const authParams = { response_type: 'code', client_id: client.clientId, redirect_uri: REDIRECT, state: 'm' };
const connect = async (access, email, password) => {
  const flow = await authorize({ authParams, access, email, password });
  const tokens = flow.code
    ? (await exchangeCode({ code: flow.code, redirect_uri: REDIRECT, client_id: client.clientId, client_secret: client.clientSecret })).body
    : null;
  return { flow, tokens };
};

// Owner connects: no picker, only the mapped token is offered
let { flow, tokens } = await connect(`token:${readToken.id}`);
check('consent page shows only the mapped token', flow.html.includes('is set up to use this admin token') && flow.tokenIds.length === 1 && flow.tokenIds[0] === readToken.id);
check('owner can connect the mapped client', !!tokens?.access_token);
const tools = await toolNames(tokens.access_token);
check('session uses the mapped token\'s permissions', tools.includes('list_article') && !tools.includes('create_article'), tools.join(', '));

// Owner tries to swap in a different token on the consent step
const swapped = await connect(`token:${writeToken.id}`);
check('a different token cannot be chosen for a mapped client', !swapped.flow.code && swapped.flow.response.status === 400);

// Another admin cannot use the mapped client
const blocked = await connect(undefined, otherEmail, PASSWORD);
check('another admin is refused at sign-in', blocked.flow.response.status === 403 && !blocked.flow.code);

// Changing the mapping ends existing sessions and applies the new token
res = await plugin('PUT', `/clients/${client.id}`, { adminTokenId: writeToken.id });
check('change the mapped token', res.status === 200);
check('changing the mapping ends existing sessions', (await mcp(tokens.access_token, 'tools/list')).status === 401);
({ tokens } = await connect(`token:${writeToken.id}`));
const newTools = await toolNames(tokens.access_token);
check('new sessions use the new token', newTools.includes('create_article'), newTools.join(', '));

// Deleting the mapped token blocks the client instead of falling back to the picker
await admin.call('DELETE', `/admin/admin-tokens/${writeToken.id}`);
check('deleting the mapped token ends sessions', (await mcp(tokens.access_token, 'tools/list')).status === 401);
const afterDelete = await connect(`token:${readToken.id}`);
check('client with a deleted token refuses to connect', afterDelete.flow.response.status === 403 && !afterDelete.flow.code);
const deletedListed = (await plugin('GET', '/clients')).body.data.find((c) => c.clientId === client.clientId);
check('client list flags the deleted token', deletedListed.adminToken?.missing === true);

// Clearing the mapping brings back the picker
res = await plugin('PUT', `/clients/${client.id}`, { adminTokenId: null });
flow = (await connect(`token:${readToken.id}`)).flow;
check('clearing the mapping brings back the token picker', res.status === 200 && flow.html.includes('Choose what') && !!flow.code);

await plugin('DELETE', `/clients/${client.id}`);
await admin.call('DELETE', `/admin/admin-tokens/${readToken.id}`);
finish();
