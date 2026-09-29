import assert from 'node:assert/strict';
import { test } from 'node:test';
import config from '../../server/src/config';

const validate = (value: Record<string, unknown>) => () => config.validator(value as any);

test('customer sign-in is off by default', () => {
  assert.deepEqual(config.default.identityProviders, {});
  assert.equal(config.default.endUserAccessTokenTtl, 3600);
});

test('accepts a LINE provider with a channel ID and an optional verify URL', () => {
  assert.doesNotThrow(validate({ identityProviders: { line: { channelId: '1657000000' } } }));
  assert.doesNotThrow(
    validate({ identityProviders: { line: { channelId: '1657000000', verifyUrl: 'http://localhost:4545/verify' } }, endUserAccessTokenTtl: 900 })
  );
});

test('rejects bad customer sign-in settings', () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [{ identityProviders: { line: {} } }, /channelId/],
    [{ identityProviders: { line: { channelId: '   ' } } }, /channelId/],
    [{ identityProviders: { line: { channelId: '1657000000', verifyUrl: 'not a url' } } }, /verifyUrl/],
    [{ identityProviders: { google: { clientId: 'x' } } }, /only supports "line"/],
    [{ identityProviders: 'line' }, /identityProviders/],
    [{ endUserAccessTokenTtl: 0 }, /endUserAccessTokenTtl/],
    [{ endUserAccessTokenTtl: 1.5 }, /endUserAccessTokenTtl/],
  ];
  for (const [value, message] of cases) {
    assert.throws(validate(value), message, JSON.stringify(value));
  }
});
