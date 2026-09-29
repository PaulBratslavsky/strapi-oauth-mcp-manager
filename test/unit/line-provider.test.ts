import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LINE_VERIFY_URL, createLineProvider } from '../../server/src/identity/line';
import { OAuthError } from '../../server/src/utils/oauth-error';

const CHANNEL = '1657000000';
const SUB = 'U4af4980629c1a7b3f1e2d3c4b5a69788';
const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;

const respond = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const provider = (fetchImpl: any, ...args: [string | undefined] | []) => {
  const verifyUrl = args.length > 0 ? args[0] : 'http://line.test/verify';
  return createLineProvider({ channelId: CHANNEL, verifyUrl }, fetchImpl);
};
const failsWith = (code: string, status = 400) => (error: unknown) =>
  error instanceof OAuthError && error.error === code && error.status === status;

test('returns line:<sub> for a valid token, posting the token and channel ID as a form', async () => {
  let seen: { url: string; init: RequestInit } | undefined;
  const fetchImpl = async (url: string, init: RequestInit) => {
    seen = { url, init };
    return respond(200, { iss: 'https://access.line.me', aud: CHANNEL, sub: SUB, exp: inAnHour() })();
  };
  const result = await provider(fetchImpl).verify('id-token-123');
  assert.equal(result.subject, `line:${SUB}`);
  assert.ok(result.expiresAt.getTime() > Date.now());
  assert.equal(seen?.url, 'http://line.test/verify');
  assert.equal(seen?.init.method, 'POST');
  const form = new URLSearchParams(String(seen?.init.body));
  assert.equal(form.get('id_token'), 'id-token-123');
  assert.equal(form.get('client_id'), CHANNEL);
});

test("uses LINE's endpoint when no verifyUrl is configured", async () => {
  let url = '';
  await provider(async (target: string) => {
    url = target;
    return respond(200, { aud: CHANNEL, sub: SUB, exp: inAnHour() })();
  }, undefined).verify('t');
  assert.equal(url, LINE_VERIFY_URL);
});

test('rejects another channel, an expired token and malformed subjects', async () => {
  const cases = [
    { aud: '9999999999', sub: SUB, exp: inAnHour() },
    { aud: CHANNEL, sub: SUB, exp: Math.floor(Date.now() / 1000) - 1 },
    { aud: CHANNEL, sub: 'U123', exp: inAnHour() },
    { aud: CHANNEL, sub: SUB.toUpperCase(), exp: inAnHour() },
    { aud: CHANNEL, exp: inAnHour() },
    { aud: CHANNEL, sub: SUB },
  ];
  for (const claims of cases) {
    await assert.rejects(provider(respond(200, claims)).verify('t'), failsWith('invalid_grant'), JSON.stringify(claims));
  }
});

test('maps a LINE 400 to invalid_grant', async () => {
  const lineSays = respond(400, { error: 'invalid_request', error_description: 'IdToken expired.' });
  await assert.rejects(provider(lineSays).verify('t'), failsWith('invalid_grant'));
});

test('maps other 4xx answers to invalid_grant, except rate limiting (429) and timeouts (408)', async () => {
  for (const status of [401, 403, 404]) {
    await assert.rejects(provider(respond(status, { error: 'invalid_request' })).verify('t'), failsWith('invalid_grant'), String(status));
  }
  for (const status of [408, 429]) {
    await assert.rejects(provider(respond(status, { message: 'slow down' })).verify('t'), failsWith('temporarily_unavailable', 503), String(status));
  }
});

test("logs why LINE couldn't answer, never the ID token", async () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' });
  const outages: Array<[string, (...args: any[]) => Promise<Response>, RegExp]> = [
    ['network error', async () => { throw new TypeError('fetch failed', { cause: refused }); }, /request failed \(ECONNREFUSED\)/],
    ['timeout', async () => { throw new DOMException('The operation timed out.', 'TimeoutError'); }, /no answer within 5 seconds/],
    ['5xx', respond(503, { message: 'unavailable' }), /HTTP 503/],
    ['rate limit', respond(429, { message: 'slow down' }), /HTTP 429/],
    ['request timeout', respond(408, { message: 'timeout' }), /HTTP 408/],
    ['unreadable answer', async () => new Response('<html>oops</html>', { status: 200 }), /not JSON/],
  ];
  for (const [name, fetchImpl, reason] of outages) {
    const warnings: string[] = [];
    const line = createLineProvider({ channelId: CHANNEL, verifyUrl: 'http://line.test/verify' }, fetchImpl as any, { warn: (message) => warnings.push(message) });
    await assert.rejects(line.verify('id-token-secret'), failsWith('temporarily_unavailable', 503), name);
    assert.equal(warnings.length, 1, name);
    assert.match(warnings[0], reason, name);
    assert.match(warnings[0], /http:\/\/line\.test\/verify/, `${name}: says which endpoint failed`);
    assert.ok(!warnings[0].includes('id-token-secret'), `${name}: never the ID token`);
  }
});

test('a rejected ID token is not logged as an outage', async () => {
  const warnings: string[] = [];
  const line = createLineProvider({ channelId: CHANNEL, verifyUrl: 'http://line.test/verify' }, respond(400, { error: 'invalid_request' }) as any, {
    warn: (message) => warnings.push(message),
  });
  await assert.rejects(line.verify('t'), failsWith('invalid_grant'));
  assert.deepEqual(warnings, []);
});

test('maps network errors, timeouts, 5xx and unreadable answers to temporarily_unavailable (503)', async () => {
  const failures = [
    async () => {
      throw new TypeError('fetch failed');
    },
    async () => {
      throw new DOMException('The operation timed out.', 'TimeoutError');
    },
    respond(502, { message: 'bad gateway' }),
    async () => new Response('<html>oops</html>', { status: 200 }),
    async () => new Response('null', { status: 200 }),
  ];
  for (const fetchImpl of failures) {
    await assert.rejects(provider(fetchImpl).verify('t'), failsWith('temporarily_unavailable', 503));
  }
});
