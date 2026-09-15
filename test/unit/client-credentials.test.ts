import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readClientCredentials } from '../../server/src/controllers/oauth';
import { OAuthError } from '../../server/src/services/oauth';

const ctxWith = (authorization?: string, body: Record<string, unknown> = {}) => ({
  request: { headers: authorization ? { authorization } : {}, body },
});
const basic = (raw: string) => `Basic ${Buffer.from(raw).toString('base64')}`;

test('reads client credentials from the form body', () => {
  assert.deepEqual(readClientCredentials(ctxWith(undefined, { client_id: 'id', client_secret: 'secret' })), {
    clientId: 'id',
    clientSecret: 'secret',
  });
});

test('reads and form-decodes HTTP Basic credentials', () => {
  assert.deepEqual(readClientCredentials(ctxWith(basic('my%20id:p%3Ass+word'))), {
    clientId: 'my id',
    clientSecret: 'p:ss word',
  });
});

test('secrets may contain colons after the first separator', () => {
  assert.deepEqual(readClientCredentials(ctxWith(basic('id:a:b:c'))), { clientId: 'id', clientSecret: 'a:b:c' });
});

test('malformed Basic credentials throw invalid_client (401), not a server error', () => {
  for (const raw of ['%zz:secret', 'id:%E0%A4%A', 'no-separator']) {
    assert.throws(
      () => readClientCredentials(ctxWith(basic(raw))),
      (error: unknown) => error instanceof OAuthError && error.error === 'invalid_client' && error.status === 401,
      raw
    );
  }
});
