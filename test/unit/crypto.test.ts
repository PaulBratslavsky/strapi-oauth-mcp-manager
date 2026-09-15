import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  TOKEN_PREFIX,
  generateToken,
  hashToken,
  safeEqual,
  signConsentTicket,
  verifyConsentTicket,
  verifyPkce,
} from '../../server/src/utils/crypto';

test('generateToken uses the prefix and is unique', () => {
  const a = generateToken(TOKEN_PREFIX.accessToken);
  const b = generateToken(TOKEN_PREFIX.accessToken);
  assert.ok(a.startsWith('mcp_at_'));
  assert.notEqual(a, b);
  assert.match(a.slice(TOKEN_PREFIX.accessToken.length), /^[A-Za-z0-9_-]{43}$/);
});

test('hashToken is a stable SHA-256 hex digest', () => {
  assert.equal(hashToken('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.notEqual(hashToken('abc'), hashToken('abd'));
});

test('safeEqual compares by value, including different lengths', () => {
  assert.equal(safeEqual('secret', 'secret'), true);
  assert.equal(safeEqual('secret', 'secreT'), false);
  assert.equal(safeEqual('secret', 'secret-longer'), false);
});

test('verifyPkce accepts the RFC 7636 appendix B example', () => {
  assert.equal(
    verifyPkce('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM'),
    true
  );
});

test('verifyPkce rejects a wrong or malformed verifier', () => {
  const challenge = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
  assert.equal(verifyPkce('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXX', challenge), false);
  assert.equal(verifyPkce('too-short', challenge), false);
  assert.equal(verifyPkce('x'.repeat(129), challenge), false);
  assert.equal(verifyPkce('has spaces in it and is long enough to pass length check', challenge), false);
});

test('consent tickets verify only for the same secret and request', () => {
  const ticket = signConsentTicket('secret', 42, 'client|redirect|challenge|state');
  assert.equal(verifyConsentTicket('secret', ticket, 'client|redirect|challenge|state'), 42);
  assert.equal(verifyConsentTicket('other-secret', ticket, 'client|redirect|challenge|state'), null);
  assert.equal(verifyConsentTicket('secret', ticket, 'client|redirect|challenge|other-state'), null);
});

test('consent tickets reject tampering and expiry', () => {
  const ticket = signConsentTicket('secret', 42, 'binding');
  const [, expiresAt, signature] = ticket.split('.');
  assert.equal(verifyConsentTicket('secret', `1.${expiresAt}.${signature}`, 'binding'), null);
  assert.equal(verifyConsentTicket('secret', 'garbage', 'binding'), null);
  const expired = signConsentTicket('secret', 42, 'binding', -1);
  assert.equal(verifyConsentTicket('secret', expired, 'binding'), null);
});
