// Customer sign-in with LINE. Needs strapi-local started with
// LINE_LOGIN_CHANNEL_ID=1234567890 LINE_VERIFY_URL=http://localhost:4545/verify (this script starts the mock).
import { BASE, OAUTH, PLUGIN, adminSession, check, contentPermission, finish, initializeParams, mcp, registerClient, toolNames } from './helpers.mjs';
import { startMockLineVerify } from './mock-line-verify.mjs';

const CHANNEL = process.env.LINE_LOGIN_CHANNEL_ID ?? '1234567890';
const EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ID_TOKEN = 'urn:ietf:params:oauth:token-type:id_token';
const SUB = `U${'a'.repeat(32)}`;

const mock = await startMockLineVerify({ port: 4545, channelId: CHANNEL });
const form = (params) =>
  fetch(`${OAUTH}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) })
    .then(async (res) => ({ status: res.status, body: await res.json() }));
const exchange = (clientId, subjectToken, extra = {}) =>
  form({ grant_type: EXCHANGE, client_id: clientId, subject_token: subjectToken, subject_token_type: ID_TOKEN, resource: `${BASE}/mcp`, ...extra });

// 0. The app must have LINE sign-in on
const metadata = await (await fetch(`${BASE}/.well-known/oauth-authorization-server`)).json();
if (!metadata.grant_types_supported?.includes(EXCHANGE)) {
  console.error(`LINE sign-in is off in the app at ${BASE}. Start it with LINE_LOGIN_CHANNEL_ID=${CHANNEL} LINE_VERIFY_URL=${mock.url}`);
  await mock.close();
  process.exit(1);
}
check('discovery lists token exchange', true);

const admin = await adminSession();
const plugin = (method, path, body) => admin.call(method, `/${PLUGIN}${path}`, body);
const readOnly = await admin.createAdminToken('E2E LINE read-only', [contentPermission('read')]);

// 1. Client rules
let res = await plugin('POST', '/clients', { name: 'E2E LINE app', endUserProvider: 'line', redirectUris: [] });
check('a LINE client needs a mapped token', res.status === 400, JSON.stringify(res.body));
res = await plugin('POST', '/clients', { name: 'E2E LINE app', endUserProvider: 'line', redirectUris: [], confidential: true, adminTokenId: readOnly.id });
check('a LINE client is created without redirect URIs', res.status === 201, JSON.stringify(res.body));
check('a LINE client is public (no secret)', res.body.data?.clientSecret === null);
const line = res.body.data;
const listed = (await plugin('GET', '/clients')).body.data.find((c) => c.clientId === line.clientId);
check('the client is listed as LINE', listed?.endUserProvider === 'line');
res = await plugin('PUT', `/clients/${line.id}`, { adminTokenId: null });
check("a LINE client's token can't be removed", res.status === 400, JSON.stringify(res.body));

// 2. Exchange
res = await exchange(line.clientId, `valid.${SUB}`);
check('exchange returns an MCP session token', res.status === 200 && res.body.access_token?.startsWith('mcp_at_'), JSON.stringify(res.body));
check('the response is an RFC 8693 answer with no refresh token',
  res.body.issued_token_type === 'urn:ietf:params:oauth:token-type:access_token' && res.body.token_type === 'Bearer' && res.body.scope === 'mcp' && !('refresh_token' in res.body));
const session = res.body.access_token;

const init = await mcp(session, 'initialize', initializeParams);
check('/mcp accepts the customer session', init.status === 200 && !!init.rpc?.result?.serverInfo);
const tools = await toolNames(session);
check("the session has exactly the mapped token's tools", tools.includes('list_article') && !tools.includes('create_article'), tools.join(', '));

const grants = (await plugin('GET', '/grants')).body.data;
const grant = grants.find((g) => g.clientId === line.clientId);
check('the sessions list shows a masked customer', grant?.subject === `line:${SUB.slice(0, 4)}…${SUB.slice(-2)}`, grant?.subject);
check('the session ends with its access token (refreshExpiresAt = expiresAt)', grant && Math.abs(new Date(grant.refreshExpiresAt) - new Date(grant.expiresAt)) < 1000);

// 3. Rejections
res = await exchange(line.clientId, `wrong-aud.${SUB}`);
check('an ID token for another channel is invalid_grant', res.status === 400 && res.body.error === 'invalid_grant', JSON.stringify(res.body));
res = await exchange(line.clientId, `expired.${SUB}`);
check('an expired ID token is invalid_grant', res.status === 400 && res.body.error === 'invalid_grant');
res = await exchange(line.clientId, `valid.${SUB}`, { subject_token_type: 'urn:ietf:params:oauth:token-type:jwt' });
check('another subject token type is invalid_request', res.status === 400 && res.body.error === 'invalid_request');
res = await form({ grant_type: 'authorization_code', client_id: line.clientId, code: 'mcp_code_x', redirect_uri: 'http://localhost/cb', code_verifier: 'x' });
check('a LINE client cannot use authorization_code', res.body.error === 'unauthorized_client', JSON.stringify(res.body));
res = await form({ grant_type: 'refresh_token', client_id: line.clientId, refresh_token: 'mcp_rt_x' });
check('a LINE client cannot refresh', res.body.error === 'unauthorized_client');
const staff = await registerClient({ client_name: 'E2E staff client', redirect_uris: ['http://localhost:33418/callback'], token_endpoint_auth_method: 'none' });
res = await exchange(staff.body.client_id, `valid.${SUB}`);
check('a staff client cannot use token exchange', res.body.error === 'unauthorized_client', JSON.stringify(res.body));

// 4. Kill switch
await plugin('PUT', `/clients/${line.id}`, { active: false });
res = await mcp(session, 'initialize', initializeParams);
check('deactivating the LINE client ends its customer sessions', res.status === 401, String(res.status));

// Cleanup
await plugin('DELETE', `/clients/${line.id}`);
const staffListed = (await plugin('GET', '/clients')).body.data.find((c) => c.clientId === staff.body.client_id);
if (staffListed) await plugin('DELETE', `/clients/${staffListed.id}`);
await admin.call('DELETE', `/admin/admin-tokens/${readOnly.id}`);
await mock.close();
finish();
