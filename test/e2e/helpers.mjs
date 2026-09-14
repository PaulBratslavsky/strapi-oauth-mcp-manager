// Shared helpers for the end-to-end tests. They talk to a running Strapi over HTTP.
import { createHash, randomBytes } from 'node:crypto';

export const BASE = process.env.BASE ?? 'http://localhost:1337';
export const PLUGIN = 'strapi-oauth-mcp-manager';
export const ADMIN_EMAIL = process.env.ADMIN_EMAIL ?? 'admin@example.com';
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? 'Password123!';
export const OAUTH = `${BASE}/api/${PLUGIN}/oauth`;

const json = { 'Content-Type': 'application/json' };
const form = { 'Content-Type': 'application/x-www-form-urlencoded' };

let failures = 0;
export const check = (name, condition, extra = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`);
  if (!condition) failures++;
};
export const finish = () => {
  console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
  process.exit(failures ? 1 : 0);
};

export const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

/** Sign in to the admin API and return helpers bound to that admin's JWT. */
export const adminSession = async (email = ADMIN_EMAIL, password = ADMIN_PASSWORD) => {
  const res = await fetch(`${BASE}/admin/login`, { method: 'POST', headers: json, body: JSON.stringify({ email, password }) });
  const jwt = (await res.json()).data?.token;
  if (!jwt) throw new Error(`Admin login failed for ${email}`);
  const call = async (method, path, body) => {
    const r = await fetch(`${BASE}${path}`, { method, headers: { ...json, Authorization: `Bearer ${jwt}` }, body: body && JSON.stringify(body) });
    const text = await r.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = text;
    }
    return { status: r.status, body: parsed };
  };
  return {
    jwt,
    call,
    /** Create an admin token owned by this admin (what a user does in Settings → Admin Tokens). */
    createAdminToken: async (name, adminPermissions) => {
      const r = await call('POST', '/admin/admin-tokens', { name: `${name} ${randomBytes(3).toString('hex')}`, description: 'e2e', lifespan: null, adminPermissions });
      if (r.status !== 201) throw new Error(`Admin token creation failed: ${JSON.stringify(r.body)}`);
      return r.body.data;
    },
  };
};

export const registerClient = async (body) => {
  const res = await fetch(`${OAUTH}/register`, { method: 'POST', headers: json, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
};

const postForm = (url, params, headers = {}) =>
  fetch(url, { method: 'POST', redirect: 'manual', headers: { ...form, ...headers }, body: new URLSearchParams(params) });

/**
 * Walk the consent page: sign in, then choose access. `access` is `token:<id>` or `user`.
 * Returns the final response plus the parsed page state from the choose step.
 */
export const authorize = async ({ authParams, email = ADMIN_EMAIL, password = ADMIN_PASSWORD, access, decision = 'approve' }) => {
  const signIn = await postForm(`${OAUTH}/authorize`, { ...authParams, step: 'signin', email, password, decision: 'continue' });
  const html = await signIn.text();
  if (signIn.status !== 200) return { signIn, html, response: signIn };
  const ticket = html.match(/name="ticket" value="([^"]+)"/)?.[1];
  const tokenIds = [...html.matchAll(/value="token:(\d+)"/g)].map((m) => Number(m[1]));
  const offersUser = html.includes('value="user"');
  const response = await postForm(`${OAUTH}/authorize`, { ...authParams, step: 'choose', ticket, access: access ?? `token:${tokenIds[0]}`, decision });
  const location = response.headers.get('location');
  const code = location ? new URL(location).searchParams.get('code') : null;
  return { signIn, html, ticket, tokenIds, offersUser, response, location, code };
};

export const exchangeCode = async (params, headers) => {
  const res = await postForm(`${OAUTH}/token`, { grant_type: 'authorization_code', ...params }, headers);
  return { status: res.status, body: await res.json() };
};

export const refresh = async (params) => {
  const res = await postForm(`${OAUTH}/token`, { grant_type: 'refresh_token', ...params });
  return { status: res.status, body: await res.json() };
};

export const revoke = (params) => postForm(`${OAUTH}/revoke`, params);

export const mcp = async (token, method, params = {}) => {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { ...json, Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await res.text();
  let rpc = null;
  try {
    const dataLine = text.split('\n').find((l) => l.startsWith('data: '));
    rpc = JSON.parse(dataLine ? dataLine.slice(6) : text);
  } catch {
    // not JSON
  }
  return { status: res.status, headers: res.headers, rpc };
};

export const initializeParams = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1.0' } };

export const toolNames = async (token) => ((await mcp(token, 'tools/list')).rpc?.result?.tools ?? []).map((t) => t.name).filter((n) => n !== 'log');

export const callTool = async (token, name, args) => {
  const { rpc } = await mcp(token, 'tools/call', { name, arguments: args });
  if (rpc?.error) return { ok: false, message: rpc.error.message };
  if (rpc?.result?.isError) return { ok: false, message: rpc.result.content?.[0]?.text };
  return { ok: true, result: rpc?.result?.structuredContent };
};

export const ARTICLE = 'api::article.article';
export const ARTICLE_FIELDS = (process.env.FIELDS ?? 'title,body').split(',');
/** A content-manager permission on the test content type. Roles with field restrictions need explicit fields. */
export const contentPermission = (action) => ({
  action: `plugin::content-manager.explorer.${action}`,
  subject: process.env.SUBJECT ?? ARTICLE,
  ...(['read', 'create', 'update'].includes(action) ? { properties: { fields: ARTICLE_FIELDS } } : {}),
});

/** Delete a client by its OAuth client_id so test runs don't leave registrations behind. */
export const deleteClient = async (admin, clientId) => {
  const clients = (await admin.call('GET', `/${PLUGIN}/clients`)).body.data;
  const client = clients.find((c) => c.clientId === clientId);
  if (client) await admin.call('DELETE', `/${PLUGIN}/clients/${client.id}`);
};
