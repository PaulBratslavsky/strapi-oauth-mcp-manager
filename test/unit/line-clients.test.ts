import assert from 'node:assert/strict';
import { test } from 'node:test';
import adminController from '../../server/src/controllers/admin';
import oauthController from '../../server/src/controllers/oauth';
import oauthService, { OAuthError } from '../../server/src/services/oauth';
import { lineWorld } from './helpers/in-memory-strapi';

// One LINE channel is configured, so every LINE client accepts the same ID tokens: a customer could
// pick whichever active LINE client maps the broader admin token. Only one may be active at a time.

const secondLineClient = { id: 2, name: 'Old app', clientId: 'mcp_client_line_old', clientSecret: null, redirectUris: [], tokenEndpointAuthMethod: 'none', registrationType: 'manual', adminTokenId: 8, endUserProvider: 'line', active: false };
const newLineClient = { name: 'Second app', redirectUris: [], confidential: false, adminTokenId: 8, endUserProvider: 'line' as const, actingUserId: 1 };

const interchangeable = (otherName: string) => (error: any) =>
  error instanceof OAuthError &&
  error.error === 'invalid_request' &&
  error.status === 400 &&
  error.description.includes(`"${otherName}"`) &&
  /one configured LINE channel, so they're interchangeable/.test(error.description) &&
  /Deactivate or delete/.test(error.description);

test('a LINE client cannot be created while another LINE client is active', async () => {
  const world = lineWorld();
  const service = oauthService({ strapi: world.strapi });
  await assert.rejects(service.createClient(newLineClient), interchangeable('Maison app'));
  assert.equal(world.clients.length, 1, 'nothing was created');
});

test('a LINE client can be created when the only other LINE client is inactive', async () => {
  const world = lineWorld();
  world.clients[0].active = false;
  const service = oauthService({ strapi: world.strapi });
  const created = await service.createClient(newLineClient);
  assert.equal(created.clientSecret, null);
  assert.equal(world.clients.find((client) => client.id === created.id)?.active, true);
});

test('a LINE client cannot be re-activated while another LINE client is active', async () => {
  const world = lineWorld();
  world.clients.push(secondLineClient);
  const service = oauthService({ strapi: world.strapi });
  await assert.rejects(service.setClientActive(2, true), interchangeable('Maison app'));
  assert.equal(world.clients.find((client) => client.id === 2)?.active, false, 'still inactive');
});

test('a LINE client can be re-activated once the other one is off, and deactivating is never refused', async () => {
  const world = lineWorld();
  world.clients.push(secondLineClient);
  const service = oauthService({ strapi: world.strapi });
  await service.setClientActive(1, false);
  await service.setClientActive(2, true);
  assert.deepEqual(world.clients.map((client) => [client.id, client.active]), [[1, false], [2, true]]);
});

test('staff clients are not limited by an active LINE client', async () => {
  const world = lineWorld();
  const service = oauthService({ strapi: world.strapi });
  const staff = await service.createClient({ name: 'ChatGPT', redirectUris: ['https://chatgpt.com/cb'], confidential: true, actingUserId: 1 });
  await service.setClientActive(staff.id, false);
  await service.setClientActive(staff.id, true);
  assert.equal(world.clients.find((client) => client.id === staff.id)?.active, true);
});

// The admin page shows error.response.data.error.message from a 400, so both refusals must be 400s.

const adminRequest = async (action: 'createClient' | 'updateClient', service: Record<string, unknown>, body: Record<string, unknown>) => {
  const ctx: any = {
    params: { id: '2' },
    request: { body },
    state: { user: { id: 1 } },
    badRequest: (message: string) => {
      ctx.status = 400;
      ctx.body = { data: null, error: { status: 400, message } };
    },
    notFound: (message: string) => {
      ctx.status = 404;
      ctx.body = { data: null, error: { status: 404, message } };
    },
  };
  const strapi = { plugin: () => ({ service: () => service }) } as any;
  await adminController({ strapi })[action](ctx);
  return ctx;
};

test('the admin API answers a refused create or re-activation with 400 and the reason', async () => {
  const refusal = new OAuthError('invalid_request', 'Only one LINE client can be active at a time.');
  const refuse = async () => {
    throw refusal;
  };

  const created = await adminRequest('createClient', { createClient: refuse }, { name: 'Second app', endUserProvider: 'line', adminTokenId: 8 });
  assert.equal(created.status, 400);
  assert.equal(created.body.error.message, refusal.description);

  const reactivated = await adminRequest('updateClient', { setClientActive: refuse }, { active: true });
  assert.equal(reactivated.status, 400);
  assert.equal(reactivated.body.error.message, refusal.description);
});

// /authorize is the staff consent flow. LINE clients use token exchange only.

const authorizeCtx = (input: Record<string, string>) => {
  const ctx: any = {
    query: input,
    request: { body: input, origin: 'http://localhost:1337' },
    responseHeaders: {} as Record<string, string>,
    set: (key: string, value: string) => (ctx.responseHeaders[key] = value),
    redirect: (url: string) => (ctx.redirectedTo = url),
  };
  return ctx;
};

test('/authorize refuses a LINE client with unauthorized_client, without redirecting', async () => {
  const lineClient = { id: 1, name: 'Maison app', clientId: 'mcp_client_line', redirectUris: ['https://app.example.com/cb'], tokenEndpointAuthMethod: 'none', registrationType: 'manual', adminTokenId: 7, endUserProvider: 'line', active: true };
  const strapi = {
    config: { get: () => undefined },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    plugin: () => ({ service: () => ({ findClient: async () => lineClient }) }),
  } as any;
  const controller = oauthController({ strapi });
  // Even with a redirect URI the client registered, the error is shown, never sent back to it.
  const input = { response_type: 'code', client_id: lineClient.clientId, redirect_uri: 'https://app.example.com/cb', code_challenge: 'x'.repeat(43), state: 's' };

  for (const action of ['authorize', 'authorizeSubmit'] as const) {
    const ctx = authorizeCtx(input);
    await controller[action](ctx);
    assert.equal(ctx.status, 400, action);
    assert.equal(ctx.type, 'html', action);
    assert.match(ctx.body, /unauthorized_client/, action);
    assert.match(ctx.body, /signs customers in with LINE/, action);
    assert.equal(ctx.redirectedTo, undefined, `${action}: no redirect`);
  }
});
