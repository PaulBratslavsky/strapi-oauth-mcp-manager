import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  getOAuthBasePath,
  isAllowedRegisteredRedirectUri,
  isInsecureOrigin,
  matchRedirectUri,
  normalizeRedirectUris,
} from '../../server/src/utils/url';

test('matchRedirectUri requires an exact match without wildcards', () => {
  const allowed = ['https://chatgpt.com/connector_platform_oauth_redirect'];
  assert.equal(matchRedirectUri('https://chatgpt.com/connector_platform_oauth_redirect', allowed), true);
  assert.equal(matchRedirectUri('https://chatgpt.com/connector_platform_oauth_redirect?x=1', allowed), false);
  assert.equal(matchRedirectUri('https://chatgpt.com.evil.com/connector_platform_oauth_redirect', allowed), false);
});

test('matchRedirectUri wildcards match within one path segment only', () => {
  const allowed = ['http://localhost:*/callback', 'https://*.example.com/cb'];
  assert.equal(matchRedirectUri('http://localhost:3020/callback', allowed), true);
  assert.equal(matchRedirectUri('https://app.example.com/cb', allowed), true);
  assert.equal(matchRedirectUri('https://evil.com/x.example.com/cb', allowed), false);
  assert.equal(matchRedirectUri('http://localhost:3020/other/callback', allowed), false);
});

test('matchRedirectUri escapes regex characters in patterns', () => {
  assert.equal(matchRedirectUri('https://aexample.com/cb', ['https://a.example.com/cb']), false);
});

test('self-registered redirect URIs: https, loopback http, native schemes', () => {
  assert.equal(isAllowedRegisteredRedirectUri('https://claude.ai/api/mcp/auth_callback'), true);
  assert.equal(isAllowedRegisteredRedirectUri('http://localhost:3020/oauth/callback'), true);
  assert.equal(isAllowedRegisteredRedirectUri('http://127.0.0.1:33418/callback'), true);
  assert.equal(isAllowedRegisteredRedirectUri('cursor://anysphere.cursor-retrieval/oauth/callback'), true);
});

test('self-registered redirect URIs reject unsafe values', () => {
  assert.equal(isAllowedRegisteredRedirectUri('http://example.com/callback'), false);
  assert.equal(isAllowedRegisteredRedirectUri('https://*.example.com/callback'), false);
  assert.equal(isAllowedRegisteredRedirectUri('https://example.com/callback#fragment'), false);
  assert.equal(isAllowedRegisteredRedirectUri('javascript:alert(1)'), false);
  assert.equal(isAllowedRegisteredRedirectUri('data:text/html,hi'), false);
  assert.equal(isAllowedRegisteredRedirectUri('not a url'), false);
  assert.equal(isAllowedRegisteredRedirectUri(42), false);
});

test('isInsecureOrigin flags plain http outside loopback', () => {
  assert.equal(isInsecureOrigin('http://cms.example.com'), true);
  assert.equal(isInsecureOrigin('https://cms.example.com'), false);
  assert.equal(isInsecureOrigin('http://localhost:1337'), false);
  assert.equal(isInsecureOrigin('http://127.0.0.1:1337'), false);
});

test('normalizeRedirectUris handles arrays, JSON strings and plain strings', () => {
  assert.deepEqual(normalizeRedirectUris(['a', 1, 'b']), ['a', 'b']);
  assert.deepEqual(normalizeRedirectUris('["a","b"]'), ['a', 'b']);
  assert.deepEqual(normalizeRedirectUris('https://x.com/cb'), ['https://x.com/cb']);
  assert.deepEqual(normalizeRedirectUris(undefined), []);
});

test('getOAuthBasePath follows the REST prefix', () => {
  const strapi = (prefix?: string) => ({ config: { get: () => prefix } }) as any;
  assert.equal(getOAuthBasePath(strapi()), '/api/strapi-oauth-mcp-manager/oauth');
  assert.equal(getOAuthBasePath(strapi('/v1')), '/v1/strapi-oauth-mcp-manager/oauth');
});
