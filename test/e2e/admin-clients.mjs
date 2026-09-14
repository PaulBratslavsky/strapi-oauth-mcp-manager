// Confidential client (ChatGPT-style) created from the admin API, plus admin revocation.
const BASE = process.env.BASE ?? 'http://localhost:1337';
const P = 'strapi-oauth-mcp-manager';
const REDIRECT = 'https://chatgpt.com/connector_platform_oauth_redirect';
let failures = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`); if (!cond) failures++; };
const json = { 'Content-Type': 'application/json' };
const form = { 'Content-Type': 'application/x-www-form-urlencoded' };

const login = await (await fetch(`${BASE}/admin/login`, { method: 'POST', headers: json, body: JSON.stringify({ email: (process.env.ADMIN_EMAIL ?? 'admin@example.com'), password: (process.env.ADMIN_PASSWORD ?? 'Password123!') }) })).json();
const jwt = login.data?.token;
check('admin login', !!jwt);
const admin = (method, path, body) => fetch(`${BASE}/${P}${path}`, { method, headers: { ...json, Authorization: `Bearer ${jwt}` }, body: body && JSON.stringify(body) });

let res = await fetch(`${BASE}/${P}/grants`);
check('admin API requires auth', res.status === 401 || res.status === 403, String(res.status));

res = await admin('GET', '/overview');
const overview = (await res.json()).data;
check('overview reports MCP enabled + key configured', overview?.mcpEnabled && overview?.encryptionKeyConfigured, JSON.stringify(overview?.endpoints?.resource));

res = await admin('POST', '/clients', { name: 'ChatGPT', redirectUris: [REDIRECT], confidential: true });
const created = (await res.json()).data;
check('create confidential client', res.status === 201 && created?.clientSecret?.startsWith('mcp_secret_'));

const authorize = await fetch(`${BASE}/api/${P}/oauth/authorize`, {
  method: 'POST', redirect: 'manual', headers: form,
  body: new URLSearchParams({ response_type: 'code', client_id: created.clientId, redirect_uri: REDIRECT, state: 's1', email: (process.env.ADMIN_EMAIL ?? 'admin@example.com'), password: (process.env.ADMIN_PASSWORD ?? 'Password123!'), decision: 'approve' }),
});
const code = new URL(authorize.headers.get('location')).searchParams.get('code');
check('confidential client may skip PKCE', authorize.status === 302 && !!code);

const basic = 'Basic ' + Buffer.from(`${created.clientId}:wrong`).toString('base64');
res = await fetch(`${BASE}/api/${P}/oauth/token`, { method: 'POST', headers: { ...form, Authorization: basic }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT }) });
check('wrong client secret → 401', res.status === 401);

const authorize2 = await fetch(`${BASE}/api/${P}/oauth/authorize`, {
  method: 'POST', redirect: 'manual', headers: form,
  body: new URLSearchParams({ response_type: 'code', client_id: created.clientId, redirect_uri: REDIRECT, email: (process.env.ADMIN_EMAIL ?? 'admin@example.com'), password: (process.env.ADMIN_PASSWORD ?? 'Password123!'), decision: 'approve' }),
});
const code2 = new URL(authorize2.headers.get('location')).searchParams.get('code');
res = await fetch(`${BASE}/api/${P}/oauth/token`, { method: 'POST', headers: form, body: new URLSearchParams({ grant_type: 'authorization_code', code: code2, redirect_uri: REDIRECT, client_id: created.clientId, client_secret: created.clientSecret }) });
const tokens = await res.json();
check('client_secret_post exchange', res.status === 200 && !!tokens.access_token);

const mcp = (body) => fetch(`${BASE}/mcp`, { method: 'POST', headers: { ...json, Accept: 'application/json, text/event-stream', Authorization: `Bearer ${tokens.access_token}` }, body: JSON.stringify(body) });
res = await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
const text = await res.text();
const tools = JSON.parse(text.split('\n').find((l) => l.startsWith('data: '))?.slice(6) ?? text).result.tools.map((t) => t.name);
check('OAuth client content type is not exposed as MCP tools', !tools.some((t) => t.includes('mcp-oauth')), tools.join(', '));

res = await admin('GET', '/grants');
const grants = (await res.json()).data;
const grant = grants.find((g) => g.clientId === created.clientId);
check('grant listed with approving user', grant?.userEmail === (process.env.ADMIN_EMAIL ?? 'admin@example.com') && grant?.clientName === 'ChatGPT');

const tokenList = await (await fetch(`${BASE}/admin/admin-tokens`, { headers: { Authorization: `Bearer ${jwt}` } })).json().catch(() => ({}));
const minted = (tokenList.data ?? []).filter((t) => t.name?.startsWith('MCP OAuth · ChatGPT'));
check('admin token minted and visible in Settings', minted.length >= 1, `${minted.length} token(s)`);

res = await admin('DELETE', `/grants/${grant.id}`);
check('admin revokes grant', res.status === 200);
res = await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
check('revoked session → 401', res.status === 401);
const tokenList2 = await (await fetch(`${BASE}/admin/admin-tokens`, { headers: { Authorization: `Bearer ${jwt}` } })).json().catch(() => ({}));
check('backing admin token deleted', (tokenList2.data ?? []).filter((t) => t.name?.startsWith('MCP OAuth · ChatGPT')).length === minted.length - 1);

res = await admin('PUT', `/clients/${created.id}`, { active: false });
check('deactivate client', res.status === 200);
res = await fetch(`${BASE}/api/${P}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: created.clientId, redirect_uri: REDIRECT })}`);
check('inactive client cannot authorize', res.status === 400);
res = await admin('DELETE', `/clients/${created.id}`);
check('delete client', res.status === 200);

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
