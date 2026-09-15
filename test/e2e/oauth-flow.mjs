// The OAuth flow an MCP client runs: discovery, registration, consent with a token picker,
// code exchange with PKCE, MCP calls, refresh rotation and revocation.
import {
  BASE, OAUTH, adminSession, deleteClient, authorize, callTool, check, contentPermission, exchangeCode, finish,
  initializeParams, mcp, pkce, refresh, registerClient, revoke, sleep, toolNames,
} from './helpers.mjs';

const REDIRECT = 'http://localhost:33418/callback';

// 1. Unauthenticated request → 401 pointing at protected resource metadata
let res = await mcp(null, 'initialize', initializeParams);
const wwwAuth = res.headers.get('www-authenticate') ?? '';
check('401 without token', res.status === 401, String(res.status));
const prmUrl = wwwAuth.match(/resource_metadata="([^"]+)"/)?.[1];
check('WWW-Authenticate has resource_metadata', !!prmUrl, wwwAuth);

// 2. Discovery
const prm = await (await fetch(prmUrl)).json();
check('protected resource is /mcp', prm.resource === `${BASE}/mcp`, prm.resource);
const as = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
check('metadata advertises S256 and registration', as.code_challenge_methods_supported?.includes('S256') && !!as.registration_endpoint);

// 3. Dynamic client registration
const reg = await registerClient({ client_name: 'E2E Test Client', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' });
check('registration returns 201', reg.status === 201, JSON.stringify(reg.body));
check('registration rejects wildcard redirect', (await registerClient({ redirect_uris: ['https://*.evil.com/cb'] })).status === 400);

// A read-only admin token, created the way a user would in Settings → Admin Tokens
const admin = await adminSession();
const readOnly = await admin.createAdminToken('E2E read-only', [contentPermission('read')]);

// 4. Authorization request validation
const { verifier, challenge } = pkce();
const state = 'state-123';
const authParams = { response_type: 'code', client_id: reg.body.client_id, redirect_uri: REDIRECT, state, code_challenge: challenge, code_challenge_method: 'S256', resource: prm.resource };

res = await fetch(`${as.authorization_endpoint}?${new URLSearchParams(authParams)}`);
const signInHtml = await res.text();
check('sign-in page renders', res.status === 200 && signInHtml.includes('E2E Test Client') && signInHtml.includes('name="password"'));
check('CSP allows the redirect origin', (res.headers.get('content-security-policy') ?? '').includes('http://localhost:33418'));

res = await fetch(`${as.authorization_endpoint}?${new URLSearchParams({ ...authParams, code_challenge: '' })}`, { redirect: 'manual' });
check('public client without PKCE is refused', res.status === 302 && res.headers.get('location').includes('error=invalid_request'));
res = await fetch(`${as.authorization_endpoint}?${new URLSearchParams({ ...authParams, redirect_uri: 'https://evil.com/cb' })}`, { redirect: 'manual' });
check('unregistered redirect_uri shows an error page, no redirect', res.status === 400);

// 5. Consent
let flow = await authorize({ authParams, password: 'wrong' });
check('wrong password is rejected', flow.response.status === 401);

flow = await authorize({ authParams, access: `token:${readOnly.id}`, decision: 'deny' });
check('choose step lists the user\'s admin tokens', flow.tokenIds.includes(readOnly.id));
check('"All of my permissions" is hidden by default', !flow.offersUser);
check('deny redirects with access_denied', flow.response.status === 302 && flow.location.includes('error=access_denied'));

flow = await authorize({ authParams, access: 'user' });
check('"All of my permissions" is refused by default', flow.response.status === 400 && !flow.code);

flow = await authorize({ authParams, access: 'token:999999' });
check('a token the user does not own is refused', flow.response.status === 400 && !flow.code);

flow = await authorize({ authParams, access: `token:${readOnly.id}` });
const forged = await fetch(`${OAUTH}/authorize`, {
  method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ ...authParams, step: 'choose', ticket: flow.ticket.replace(/^\d+/, '999'), access: `token:${readOnly.id}`, decision: 'approve' }),
});
check('a tampered consent ticket is rejected', forged.status === 401);
const otherRequest = await fetch(`${OAUTH}/authorize`, {
  method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ ...authParams, state: 'different', step: 'choose', ticket: flow.ticket, access: `token:${readOnly.id}`, decision: 'approve' }),
});
check('a consent ticket cannot be reused for another request', otherRequest.status === 401);
check('approve redirects with code and state', flow.response.status === 302 && !!flow.code && new URL(flow.location).searchParams.get('state') === state);

// 6. Code exchange
let tokenRes = await exchangeCode({ code: flow.code, redirect_uri: REDIRECT, client_id: reg.body.client_id, code_verifier: 'x'.repeat(43) });
check('wrong PKCE verifier is rejected', tokenRes.status === 400);

flow = await authorize({ authParams, access: `token:${readOnly.id}` });
tokenRes = await exchangeCode({ code: flow.code, redirect_uri: REDIRECT, client_id: reg.body.client_id, code_verifier: verifier });
const tokens = tokenRes.body;
check('code exchange returns tokens', tokenRes.status === 200 && tokens.access_token?.startsWith('mcp_at_'));
check('a code cannot be used twice', (await exchangeCode({ code: flow.code, redirect_uri: REDIRECT, client_id: reg.body.client_id, code_verifier: verifier })).status === 400);

// 7. MCP with the OAuth token uses exactly the chosen token's permissions
res = await mcp(tokens.access_token, 'initialize', initializeParams);
check('MCP initialize works with the OAuth token', res.status === 200 && !!res.rpc?.result?.serverInfo);
const tools = await toolNames(tokens.access_token);
check('read-only token exposes only read tools', tools.includes('list_article') && !tools.includes('create_article'), tools.join(', '));
check('create is refused with a read-only token', !(await callTool(tokens.access_token, 'create_article', { data: { title: 'nope' } })).ok);
res = await mcp('mcp_at_not-a-real-token', 'initialize', initializeParams);
check('unknown OAuth token → 401 invalid_token', res.status === 401 && (res.headers.get('www-authenticate') ?? '').includes('invalid_token'));

// 8. Refresh rotation
const refreshed = await refresh({ refresh_token: tokens.refresh_token, client_id: reg.body.client_id });
check('refresh returns new tokens', refreshed.status === 200 && refreshed.body.access_token !== tokens.access_token);
check('old access token stops working', (await mcp(tokens.access_token, 'tools/list')).status === 401);
check('old refresh token stops working', (await refresh({ refresh_token: tokens.refresh_token, client_id: reg.body.client_id })).status === 400);
check('new access token works', (await mcp(refreshed.body.access_token, 'tools/list')).status === 200);

// 9. Concurrent refresh: exactly one request may rotate a refresh token
const racers = await Promise.all([1, 2, 3].map(() => refresh({ refresh_token: refreshed.body.refresh_token, client_id: reg.body.client_id })));
const winners = racers.filter((r) => r.status === 200);
check('concurrent refreshes with one token: exactly one succeeds', winners.length === 1, racers.map((r) => r.status).join(', '));
const current = winners[0].body;
check('the winning tokens work', (await mcp(current.access_token, 'tools/list')).status === 200);

// 10. Reusing a rotated refresh token: harmless right away, revokes the session later
check('reuse right after rotation is rejected', (await refresh({ refresh_token: refreshed.body.refresh_token, client_id: reg.body.client_id })).status === 400);
check('reuse right after rotation keeps the session', (await mcp(current.access_token, 'tools/list')).status === 200);
await sleep((Number(process.env.REUSE_WINDOW_SECONDS ?? 10) + 1) * 1000);
check('reuse after the retry window is rejected', (await refresh({ refresh_token: refreshed.body.refresh_token, client_id: reg.body.client_id })).status === 400);
check('reuse after the retry window revokes the session', (await mcp(current.access_token, 'tools/list')).status === 401);
check('the session\'s latest refresh token stops working too', (await refresh({ refresh_token: current.refresh_token, client_id: reg.body.client_id })).status === 400);

// 11. Revocation keeps the user's own token
const { verifier: verifier2, challenge: challenge2 } = pkce();
flow = await authorize({ authParams: { ...authParams, code_challenge: challenge2 }, access: `token:${readOnly.id}` });
const fresh = (await exchangeCode({ code: flow.code, redirect_uri: REDIRECT, client_id: reg.body.client_id, code_verifier: verifier2 })).body;
res = await revoke({ token: fresh.refresh_token, client_id: reg.body.client_id });
check('revocation returns 200', res.status === 200);
check('revoked session → 401', (await mcp(fresh.access_token, 'tools/list')).status === 401);
const stillThere = await admin.call('GET', `/admin/admin-tokens/${readOnly.id}`);
check('revoking a session does not delete the chosen admin token', stillThere.status === 200);

await admin.call('DELETE', `/admin/admin-tokens/${readOnly.id}`);
await deleteClient(admin, reg.body.client_id);
finish();
