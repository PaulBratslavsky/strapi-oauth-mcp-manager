import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import pluginConfig from '../../server/src/config';
import oauthController from '../../server/src/controllers/oauth';
import oauthService from '../../server/src/services/oauth';
import { hashToken } from '../../server/src/utils/crypto';
import { GRANT_TYPE_TOKEN_EXCHANGE, TOKEN_TYPE_ACCESS_TOKEN, TOKEN_TYPE_ID_TOKEN } from '../../server/src/utils/end-user';
import { LINE_SUB, allLogs, lineVerifies, lineWorld } from './helpers/in-memory-strapi';

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

// Service-level tests against an in-memory database (see helpers/in-memory-strapi.ts).

const ID_TOKEN = 'id-token-secret';

const exchangeWith = async (world: ReturnType<typeof lineWorld>) => {
  const service = oauthService({ strapi: world.strapi });
  const client = await service.authenticateClient('mcp_client_line', undefined);
  return service.exchangeIdToken(client, { subjectToken: ID_TOKEN, subjectTokenType: TOKEN_TYPE_ID_TOKEN, resource: 'http://localhost:1337/mcp' });
};

test('a successful exchange creates a customer grant on the mapped token, with no refresh token', async () => {
  const world = lineWorld({ config: { endUserAccessTokenTtl: 900 } });
  globalThis.fetch = lineVerifies();
  const before = Date.now();
  const response: Record<string, unknown> = await exchangeWith(world);

  assert.deepEqual(Object.keys(response).sort(), ['access_token', 'expires_in', 'issued_token_type', 'scope', 'token_type']);
  assert.equal(response.issued_token_type, TOKEN_TYPE_ACCESS_TOKEN);
  assert.equal(response.token_type, 'Bearer');
  assert.equal(response.expires_in, 900);
  assert.equal(response.scope, 'mcp');
  assert.ok(!('refresh_token' in response), 'no refresh token');

  assert.equal(world.grants.length, 1);
  const grant = world.grants[0];
  assert.equal(grant.clientId, 'mcp_client_line');
  assert.equal(grant.subject, `line:${LINE_SUB}`);
  assert.equal(grant.adminTokenId, 7, "the client's mapped token");
  assert.equal(grant.adminUserId, 1, "the mapped token's owner");
  assert.equal(grant.ownsAdminToken, false, 'cleanup must never delete the mapped token');
  assert.equal(grant.scope, 'mcp');
  assert.equal(grant.resource, 'http://localhost:1337/mcp');
  assert.equal(grant.refreshTokenHash, null);
  assert.equal(grant.refreshExpiresAt, grant.expiresAt, 'the grant ends with its access token');
  assert.equal(grant.accessTokenHash, hashToken(response.access_token as string));
  assert.equal(grant.adminKeyHash, hashToken('key-customers'));
  const lifetime = new Date(grant.expiresAt).getTime() - before;
  assert.ok(lifetime > 895_000 && lifetime <= 901_000, `expires after endUserAccessTokenTtl (${lifetime} ms)`);

  const logs = allLogs(world.logs);
  assert.match(logs, /line:U4af…88/, 'the success log names the customer, masked');
  assert.ok(!logs.includes(LINE_SUB) && !logs.includes(ID_TOKEN), 'never the full subject or the ID token');
});

test('listGrants shows a customer grant with a masked subject and a staff grant with none', async () => {
  const world = lineWorld();
  globalThis.fetch = lineVerifies();
  await exchangeWith(world);
  const now = new Date().toISOString();
  world.grants.push({
    id: 99, clientId: 'mcp_client_line', adminUserId: 1, adminTokenId: 8, ownsAdminToken: false, scope: null, subject: null,
    expiresAt: now, refreshExpiresAt: now, lastUsedAt: null, createdAt: now,
  });

  const listed = await oauthService({ strapi: world.strapi }).listGrants();
  const customer = listed.find((grant: any) => grant.id !== 99);
  const staff = listed.find((grant: any) => grant.id === 99);
  assert.equal(customer.subject, 'line:U4af…88');
  assert.equal(staff.subject, null);
  assert.ok(!JSON.stringify(listed).includes(LINE_SUB), 'the full subject never reaches the admin page');
});

// Kill switches while LINE is checking the ID token (up to 5 seconds). The controller authenticated
// the client before that call, so the exchange must look at the client again after creating the grant.

type Service = ReturnType<typeof oauthService>;
const unknownOrInactiveClient = (error: any) => error.error === 'invalid_client' && error.status === 401 && error.description === 'Unknown or inactive client';
const signInUnavailable = (error: any) =>
  error.error === 'temporarily_unavailable' && error.status === 503 && error.description === "LINE sign-in isn't available right now. Try again later.";

const killSwitches: Array<{ name: string; pull: (service: Service) => Promise<unknown>; refusal: (error: any) => boolean }> = [
  { name: 'deactivated', pull: (service) => service.setClientActive(1, false), refusal: unknownOrInactiveClient },
  { name: 'deleted', pull: (service) => service.deleteClient(1), refusal: unknownOrInactiveClient },
  { name: 're-mapped to another admin token', pull: (service) => service.setClientToken(1, 8, 1), refusal: signInUnavailable },
];

for (const killSwitch of killSwitches) {
  test(`a client ${killSwitch.name} while LINE checks the ID token issues no session`, async () => {
    const world = lineWorld();
    const service = oauthService({ strapi: world.strapi });
    const client = await service.authenticateClient('mcp_client_line', undefined);
    globalThis.fetch = lineVerifies(LINE_SUB, () => killSwitch.pull(service).then(() => {}));

    await assert.rejects(
      service.exchangeIdToken(client, { subjectToken: ID_TOKEN, subjectTokenType: TOKEN_TYPE_ID_TOKEN }),
      killSwitch.refusal
    );
    assert.deepEqual(world.grants, [], 'no grant survives');
  });

  test(`a client ${killSwitch.name} after its sessions were swept but before the new grant is stored issues no session`, async () => {
    // The kill switch reads the client's grants, then LINE answers and the exchange runs to the end
    // before the kill switch deletes what it read: the new grant is not in its list.
    let exchange: Promise<unknown> = Promise.resolve();
    let lineAnswers!: () => void;
    const lineAnswered = new Promise<void>((resolve) => (lineAnswers = resolve));
    const world = lineWorld({
      hooks: {
        grants: {
          afterFindMany: async (where) => {
            if (where?.clientId !== 'mcp_client_line') return;
            lineAnswers();
            await exchange.catch(() => {});
          },
        },
      },
    });
    const service = oauthService({ strapi: world.strapi });
    const client = await service.authenticateClient('mcp_client_line', undefined);
    globalThis.fetch = lineVerifies(LINE_SUB, () => lineAnswered);

    exchange = service.exchangeIdToken(client, { subjectToken: ID_TOKEN, subjectTokenType: TOKEN_TYPE_ID_TOKEN });
    await killSwitch.pull(service);
    await assert.rejects(exchange, killSwitch.refusal);
    assert.deepEqual(world.grants, [], 'no grant survives');
  });
}
