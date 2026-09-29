import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  GRANT_TYPE_TOKEN_EXCHANGE,
  applyClientRules,
  assertCanSetClientToken,
  assertGrantTypeAllowed,
  endUserProviderOf,
  maskSubject,
} from '../../server/src/utils/end-user';
import { OAuthError } from '../../server/src/utils/oauth-error';

const failsWith = (code: string) => (error: unknown) => error instanceof OAuthError && error.error === code;

test('rows created before 1.1 (null) and unknown values are staff clients', () => {
  assert.equal(endUserProviderOf(null), 'none');
  assert.equal(endUserProviderOf(undefined), 'none');
  assert.equal(endUserProviderOf('something'), 'none');
  assert.equal(endUserProviderOf('line'), 'line');
});

test('LINE clients are always public, need a mapped token, and may have no redirect URI', () => {
  const rules = applyClientRules({ endUserProvider: 'line', confidential: true, redirectUris: [], adminTokenId: 7 });
  assert.equal(rules.confidential, false);
  assert.deepEqual(rules.redirectUris, []);
  assert.throws(
    () => applyClientRules({ endUserProvider: 'line', confidential: false, redirectUris: [], adminTokenId: null }),
    failsWith('invalid_request')
  );
});

test('staff clients still need a redirect URI and keep their client type', () => {
  assert.throws(
    () => applyClientRules({ endUserProvider: 'none', confidential: true, redirectUris: [], adminTokenId: null }),
    /redirect URI/
  );
  const staff = applyClientRules({ endUserProvider: 'none', confidential: true, redirectUris: ['https://a.example/cb'], adminTokenId: null });
  assert.equal(staff.confidential, true);
});

test("a LINE client's token can be changed but not removed", () => {
  assert.doesNotThrow(() => assertCanSetClientToken('line', 9));
  assert.throws(() => assertCanSetClientToken('line', null), failsWith('invalid_request'));
  assert.doesNotThrow(() => assertCanSetClientToken('none', null));
});

test('LINE clients only use token exchange, and only LINE clients use it', () => {
  assert.doesNotThrow(() => assertGrantTypeAllowed('line', GRANT_TYPE_TOKEN_EXCHANGE));
  assert.throws(() => assertGrantTypeAllowed('line', 'authorization_code'), failsWith('unauthorized_client'));
  assert.throws(() => assertGrantTypeAllowed('line', 'refresh_token'), failsWith('unauthorized_client'));
  assert.throws(() => assertGrantTypeAllowed('none', GRANT_TYPE_TOKEN_EXCHANGE), failsWith('unauthorized_client'));
  assert.doesNotThrow(() => assertGrantTypeAllowed('none', 'authorization_code'));
});

test('subjects are masked for logs and the admin page', () => {
  assert.equal(maskSubject('line:U4af4980629c1a7b3f1e2d3c4b5a69788'), 'line:U4af…88');
  assert.equal(maskSubject(null), null);
  assert.equal(maskSubject(''), null);
  assert.equal(maskSubject('line:U12'), 'line:…');
});
