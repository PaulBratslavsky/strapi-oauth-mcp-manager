// End-to-end OAuth flow against a running Strapi, the way an MCP client does it.
import { createHash, randomBytes } from 'node:crypto';

const BASE = process.env.BASE ?? 'http://localhost:1337';
const EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com';
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'Password123!';
const REDIRECT = 'http://localhost:33418/callback';

let failures = 0;
const check = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`);
  if (!cond) failures++;
};

const mcp = (token, body) =>
  fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

const readRpc = async (res) => {
  const text = await res.text();
  const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
  return JSON.parse(dataLine ? dataLine.slice(6) : text);
};

const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1.0' } } };
const toolsList = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };

// 1. Unauthenticated request → 401 + resource_metadata
let res = await mcp(null, initialize);
const wwwAuth = res.headers.get('www-authenticate') ?? '';
check('401 without token', res.status === 401, String(res.status));
const prmUrl = wwwAuth.match(/resource_metadata="([^"]+)"/)?.[1];
check('WWW-Authenticate has resource_metadata', !!prmUrl, wwwAuth);

// 2. Protected resource metadata → authorization server
const prm = await (await fetch(prmUrl)).json();
check('PRM resource is /mcp', prm.resource === `${BASE}/mcp`, prm.resource);
const asMeta = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
check('AS metadata has S256 + registration', asMeta.code_challenge_methods_supported?.includes('S256') && !!asMeta.registration_endpoint);

// 3. Dynamic client registration (public client, like Claude Code)
res = await fetch(asMeta.registration_endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ client_name: 'E2E Test Client', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }),
});
const reg = await res.json();
check('DCR 201', res.status === 201, JSON.stringify(reg));
res = await fetch(asMeta.registration_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://*.evil.com/cb'] }) });
check('DCR rejects wildcard redirect', res.status === 400);

// 4. Authorize page
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const state = randomBytes(8).toString('hex');
const authParams = { response_type: 'code', client_id: reg.client_id, redirect_uri: REDIRECT, state, code_challenge: challenge, code_challenge_method: 'S256', resource: prm.resource };
const authUrl = `${asMeta.authorization_endpoint}?${new URLSearchParams(authParams)}`;
res = await fetch(authUrl);
const html = await res.text();
check('authorize page renders', res.status === 200 && html.includes('E2E Test Client'));
check('authorize CSP allows redirect origin', (res.headers.get('content-security-policy') ?? '').includes('http://localhost:33418'), res.headers.get('content-security-policy'));

res = await fetch(`${asMeta.authorization_endpoint}?${new URLSearchParams({ ...authParams, code_challenge: '' })}`, { redirect: 'manual' });
check('public client without PKCE is refused', res.status === 302 && res.headers.get('location').includes('error=invalid_request'));

res = await fetch(`${asMeta.authorization_endpoint}?${new URLSearchParams({ ...authParams, redirect_uri: 'https://evil.com/cb' })}`, { redirect: 'manual' });
check('unregistered redirect_uri shows error page, no redirect', res.status === 400);

const submit = (extra) =>
  fetch(asMeta.authorization_endpoint, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...authParams, ...extra }),
  });

res = await submit({ email: EMAIL, password: 'wrong', decision: 'approve' });
check('wrong password re-renders with 401', res.status === 401);

res = await submit({ decision: 'deny' });
check('deny redirects with access_denied', res.status === 302 && res.headers.get('location').includes('error=access_denied'));

res = await submit({ email: EMAIL, password: PASSWORD, decision: 'approve' });
const location = new URL(res.headers.get('location') ?? 'http://x');
const code = location.searchParams.get('code');
check('approve redirects with code + state', res.status === 302 && !!code && location.searchParams.get('state') === state, res.headers.get('location'));

// 5. Token exchange
const tokenRequest = (params) =>
  fetch(asMeta.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });

res = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: 'x'.repeat(43) });
check('bad PKCE verifier rejected', res.status === 400);
// The code was consumed by the failed attempt, so authorize again.
res = await submit({ email: EMAIL, password: PASSWORD, decision: 'approve' });
const code2 = new URL(res.headers.get('location')).searchParams.get('code');

res = await tokenRequest({ grant_type: 'authorization_code', code: code2, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier });
const tokens = await res.json();
check('code exchange returns tokens', res.status === 200 && tokens.access_token?.startsWith('mcp_at_'), JSON.stringify(tokens).slice(0, 120));

res = await tokenRequest({ grant_type: 'authorization_code', code: code2, redirect_uri: REDIRECT, client_id: reg.client_id, code_verifier: verifier });
check('code replay rejected', res.status === 400);

// 6. Call MCP with the OAuth access token
res = await mcp(tokens.access_token, initialize);
const init = await readRpc(res);
check('MCP initialize with OAuth token', res.status === 200 && !!init.result?.serverInfo, JSON.stringify(init).slice(0, 150));
res = await mcp(tokens.access_token, toolsList);
const tools = await readRpc(res);
const toolNames = tools.result?.tools?.map((t) => t.name) ?? [];
check('tools/list returns tools', toolNames.length > 0, toolNames.join(', '));

res = await mcp('mcp_at_not-a-real-token', initialize);
check('unknown OAuth token → 401 invalid_token', res.status === 401 && (res.headers.get('www-authenticate') ?? '').includes('invalid_token'));

// 7. Refresh rotation
res = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: reg.client_id });
const refreshed = await res.json();
check('refresh returns new tokens', res.status === 200 && refreshed.access_token && refreshed.access_token !== tokens.access_token);
res = await mcp(tokens.access_token, initialize);
check('old access token rejected after refresh', res.status === 401);
res = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: reg.client_id });
check('old refresh token rejected after rotation', res.status === 400);
res = await mcp(refreshed.access_token, toolsList);
check('new access token works', res.status === 200);

// 8. Revocation
res = await fetch(asMeta.revocation_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: refreshed.refresh_token, client_id: reg.client_id }) });
check('revoke 200', res.status === 200);
res = await mcp(refreshed.access_token, initialize);
check('revoked grant → 401', res.status === 401);

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
