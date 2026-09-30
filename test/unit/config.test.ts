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

test('the LINE channel ID is digits only: the LINE Login channel ID, not the LIFF ID', () => {
  for (const channelId of ['1657000000-AbcdEfgh', ' 1657000000', '1657000000 ', 'channel-id', 1657000000]) {
    assert.throws(
      validate({ identityProviders: { line: { channelId } } }),
      (error: Error) => /channelId/.test(error.message) && /LINE Login channel/.test(error.message) && /not the LIFF ID/.test(error.message),
      JSON.stringify(channelId)
    );
  }
  assert.doesNotThrow(validate({ identityProviders: { line: { channelId: '1234567890' } } }));
});
