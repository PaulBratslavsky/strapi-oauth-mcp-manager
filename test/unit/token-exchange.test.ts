import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import pluginConfig from '../../server/src/config';
import oauthController from '../../server/src/controllers/oauth';
import oauthService from '../../server/src/services/oauth';
import { GRANT_TYPE_TOKEN_EXCHANGE, TOKEN_TYPE_ID_TOKEN } from '../../server/src/utils/end-user';

const lineClient = { id: 1, name: 'Maison app', clientId: 'mcp_client_line', redirectUris: [], tokenEndpointAuthMethod: 'none', registrationType: 'manual', adminTokenId: 7, active: true, endUserProvider: 'line' };
const staffClient = { ...lineClient, clientId: 'mcp_client_staff', adminTokenId: null, endUserProvider: 'none' };
const LINE_CONFIG = { identityProviders: { line: { channelId: '1657000000', verifyUrl: 'http://line.test/verify' } } };

/** A Strapi stand-in: plugin config, silent logs, and a database that fails the test if touched. */
const fakeStrapi = (overrides: Record<string, unknown> = {}, service?: Record<string, unknown>) =>
  ({
    config: {
      get: (key: string) => (key === 'plugin::strapi-oauth-mcp-manager' ? { ...pluginConfig.default, ...overrides } : undefined),
    },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    db: {
      query: (uid: string) => {
        throw new Error(`unexpected database access to ${uid}`);
      },
    },
    plugin: () => ({ service: () => service }),
  }) as any;

const ctxFor = (body: Record<string, string>) => {
  const headers: Record<string, string> = {};
  return { request: { body, headers: {}, origin: 'http://localhost:1337' }, set: (key: string, value: string) => (headers[key] = value), status: 200, body: undefined as any };
};

const tokenRequest = async (client: object, body: Record<string, string>) => {
  const calls: string[] = [];
  const service = {
    authenticateClient: async () => client,
    exchangeAuthorizationCode: async () => (calls.push('authorization_code'), { access_token: 'staff' }),
    refreshGrant: async () => (calls.push('refresh_token'), { access_token: 'refreshed' }),
    exchangeIdToken: async (_client: object, params: object) => (calls.push('exchange'), { access_token: 'customer', params }),
  };
  const ctx = ctxFor(body);
  await oauthController({ strapi: fakeStrapi(LINE_CONFIG, service) }).token(ctx);
  return { ctx, calls };
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

test('a LINE client exchanges its ID token', async () => {
  const { ctx, calls } = await tokenRequest(lineClient, {
    grant_type: GRANT_TYPE_TOKEN_EXCHANGE, client_id: lineClient.clientId, subject_token: 'id-token', subject_token_type: TOKEN_TYPE_ID_TOKEN, resource: 'http://localhost:1337/mcp',
  });
  assert.deepEqual(calls, ['exchange']);
  assert.deepEqual(ctx.body.params, { subjectToken: 'id-token', subjectTokenType: TOKEN_TYPE_ID_TOKEN, resource: 'http://localhost:1337/mcp' });
});

test('a LINE client cannot use the code or refresh grants', async () => {
  for (const grant_type of ['authorization_code', 'refresh_token']) {
    const { ctx, calls } = await tokenRequest(lineClient, { grant_type, code: 'x', refresh_token: 'x' });
    assert.equal(ctx.status, 400, grant_type);
    assert.equal(ctx.body.error, 'unauthorized_client', grant_type);
    assert.deepEqual(calls, []);
  }
});

test('a staff client, including one created before 1.1, cannot use token exchange', async () => {
  for (const client of [staffClient, { ...staffClient, endUserProvider: null }]) {
    const { ctx, calls } = await tokenRequest(client, { grant_type: GRANT_TYPE_TOKEN_EXCHANGE, subject_token: 'x', subject_token_type: TOKEN_TYPE_ID_TOKEN });
    assert.equal(ctx.body.error, 'unauthorized_client');
    assert.deepEqual(calls, []);
  }
  const { calls } = await tokenRequest({ ...staffClient, endUserProvider: null }, { grant_type: 'authorization_code', code: 'x' });
  assert.deepEqual(calls, ['authorization_code']);
});

test('unknown grant types are unsupported_grant_type', async () => {
  const { ctx } = await tokenRequest(staffClient, { grant_type: 'password' });
  assert.equal(ctx.body.error, 'unsupported_grant_type');
});

test('exchangeIdToken refuses when LINE sign-in is not configured', async () => {
  const service = oauthService({ strapi: fakeStrapi() });
  await assert.rejects(
    service.exchangeIdToken(lineClient as any, { subjectToken: 'x', subjectTokenType: TOKEN_TYPE_ID_TOKEN }),
    (error: any) => error.error === 'unauthorized_client' && /not configured/.test(error.description)
  );
});

test('exchangeIdToken needs subject_token and the id_token type', async () => {
  const service = oauthService({ strapi: fakeStrapi(LINE_CONFIG) });
  for (const params of [{ subjectTokenType: TOKEN_TYPE_ID_TOKEN }, { subjectToken: 'x' }, { subjectToken: 'x', subjectTokenType: 'urn:ietf:params:oauth:token-type:jwt' }]) {
    await assert.rejects(service.exchangeIdToken(lineClient as any, params), (error: any) => error.error === 'invalid_request', JSON.stringify(params));
  }
});

test('exchangeIdToken stops at invalid_grant when LINE rejects the token, before touching the database', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'invalid_request', error_description: 'IdToken expired.' }), { status: 400 })) as any;
  const service = oauthService({ strapi: fakeStrapi(LINE_CONFIG) });
  await assert.rejects(
    service.exchangeIdToken(lineClient as any, { subjectToken: 'expired', subjectTokenType: TOKEN_TYPE_ID_TOKEN }),
    (error: any) => error.error === 'invalid_grant'
  );
});

test('discovery lists token exchange only when LINE sign-in is configured', async () => {
  const grantTypes = async (overrides: Record<string, unknown>) => {
    const ctx = ctxFor({});
    await oauthController({ strapi: fakeStrapi(overrides) }).authorizationServer(ctx);
    return ctx.body.grant_types_supported as string[];
  };
  assert.ok((await grantTypes(LINE_CONFIG)).includes(GRANT_TYPE_TOKEN_EXCHANGE));
  assert.ok(!(await grantTypes({})).includes(GRANT_TYPE_TOKEN_EXCHANGE));
});
