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
  ];
  for (const fetchImpl of failures) {
    await assert.rejects(provider(fetchImpl).verify('t'), failsWith('temporarily_unavailable', 503));
  }
});
