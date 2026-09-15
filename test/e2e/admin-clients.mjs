// Confidential clients created in the admin panel, and every way to revoke access.
import {
  BASE, PLUGIN, adminSession, authorize, callTool, check, contentPermission, exchangeCode, finish, mcp, toolNames,
} from './helpers.mjs';

const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
const admin = await adminSession();
const plugin = (method, path, body) => admin.call(method, `/${PLUGIN}${path}`, body);

let res = await fetch(`${BASE}/${PLUGIN}/grants`);
check('plugin admin API requires auth', res.status === 401 || res.status === 403, String(res.status));

res = await plugin('GET', '/overview');
check('overview reports MCP enabled and encryption key set', res.body.data?.mcpEnabled && res.body.data?.encryptionKeyConfigured);

res = await plugin('POST', '/clients', { name: 'ChatGPT', redirectUris: [REDIRECT], confidential: true });
const client = res.body.data;
check('create confidential client', res.status === 201 && client?.clientSecret?.startsWith('mcp_secret_'));

const editorToken = await admin.createAdminToken('E2E editor', ['read', 'create', 'update', 'publish'].map(contentPermission));
const readToken = await admin.createAdminToken('E2E reader', [contentPermission('read')]);

const connect = async (tokenId) => {
  const flow = await authorize({ authParams: { response_type: 'code', client_id: client.clientId, redirect_uri: REDIRECT, state: 's' }, access: `token:${tokenId}` });
  return exchangeCode({ code: flow.code, redirect_uri: REDIRECT, client_id: client.clientId, client_secret: client.clientSecret });
};

// Secret checks
const flow = await authorize({ authParams: { response_type: 'code', client_id: client.clientId, redirect_uri: REDIRECT }, access: `token:${readToken.id}` });
check('confidential client may skip PKCE', !!flow.code);
const basic = 'Basic ' + Buffer.from(`${client.clientId}:wrong`).toString('base64');
check('wrong client secret → 401', (await exchangeCode({ code: flow.code, redirect_uri: REDIRECT }, { Authorization: basic })).status === 401);
const malformed = 'Basic ' + Buffer.from(`%zz:${client.clientSecret}`).toString('base64');
check('malformed Basic credentials → 401 invalid_client', await exchangeCode({ code: 'x', redirect_uri: REDIRECT }, { Authorization: malformed }).then((r) => r.status === 401 && r.body.error === 'invalid_client'));
const noColon = 'Basic ' + Buffer.from('no-separator').toString('base64');
check('Basic credentials without a colon → 401', (await exchangeCode({ code: 'x', redirect_uri: REDIRECT }, { Authorization: noColon })).status === 401);

// Two sessions, two tokens, two permission sets
const editorSession = (await connect(editorToken.id)).body;
const readerSession = (await connect(readToken.id)).body;
check('client_secret_post exchange', !!editorSession.access_token && !!readerSession.access_token);
const editorTools = await toolNames(editorSession.access_token);
const readerTools = await toolNames(readerSession.access_token);
check('editor token session can publish', editorTools.includes('publish_article'), editorTools.join(', '));
check('reader token session is read-only', readerTools.includes('get_article') && !readerTools.includes('update_article'), readerTools.join(', '));
check('plugin content types are not exposed as MCP tools', !editorTools.some((t) => t.includes('mcp-oauth')));
check('editor session can create', (await callTool(editorSession.access_token, 'create_article', { data: { title: 'From e2e' } })).ok);

res = await plugin('GET', '/grants');
const grants = res.body.data.filter((g) => g.clientId === client.clientId);
check('sessions list the approving user and token name', grants.some((g) => g.tokenName === editorToken.name && g.userEmail));

// Revoke one session: only that one stops, and the token stays
const readerGrant = grants.find((g) => g.tokenName === readToken.name);
await plugin('DELETE', `/grants/${readerGrant.id}`);
check('revoking a session stops it', (await mcp(readerSession.access_token, 'tools/list')).status === 401);
check('other sessions keep working', (await mcp(editorSession.access_token, 'tools/list')).status === 200);
check('the chosen token is not deleted', (await admin.call('GET', `/admin/admin-tokens/${readToken.id}`)).status === 200);

// Regenerating a token ends its sessions
const regenSession = (await connect(readToken.id)).body;
check('new session on the reader token works', (await mcp(regenSession.access_token, 'tools/list')).status === 200);
await admin.call('POST', `/admin/admin-tokens/${readToken.id}/regenerate`);
check('regenerating the token ends its sessions', (await mcp(regenSession.access_token, 'tools/list')).status === 401);

// Deleting a token ends its sessions
const deleteSession = (await connect(readToken.id)).body;
const grantsBefore = (await plugin('GET', '/grants')).body.data.filter((g) => g.adminTokenId === readToken.id).length;
await admin.call('DELETE', `/admin/admin-tokens/${readToken.id}`);
const grantsAfter = (await plugin('GET', '/grants')).body.data.filter((g) => g.adminTokenId === readToken.id).length;
check('deleting the token removes its sessions from the list', grantsBefore > 0 && grantsAfter === 0, `${grantsBefore} → ${grantsAfter}`);
check('deleting the token ends its sessions', (await mcp(deleteSession.access_token, 'tools/list')).status === 401);

// Revoke all for a user
const second = (await connect(editorToken.id)).body;
const me = (await admin.call('GET', '/admin/users/me')).body.data;
res = await plugin('DELETE', `/users/${me.id}/grants`);
check('revoke all for user reports sessions revoked', res.status === 200 && res.body.data.revoked >= 2, JSON.stringify(res.body));
check('revoke all for user ends every session', (await mcp(editorSession.access_token, 'tools/list')).status === 401 && (await mcp(second.access_token, 'tools/list')).status === 401);

// Deactivating the client ends sessions and blocks new ones
const beforeDeactivate = (await connect(editorToken.id)).body;
await plugin('PUT', `/clients/${client.id}`, { active: false });
check('deactivating the client ends its sessions', (await mcp(beforeDeactivate.access_token, 'tools/list')).status === 401);
res = await fetch(`${BASE}/api/${PLUGIN}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.clientId, redirect_uri: REDIRECT })}`);
check('inactive client cannot start authorization', res.status === 400);
check('delete client', (await plugin('DELETE', `/clients/${client.id}`)).status === 200);

await admin.call('DELETE', `/admin/admin-tokens/${editorToken.id}`);
finish();
