import assert from 'node:assert/strict';
import { test } from 'node:test';
import bootstrap from '../../server/src/bootstrap';
import pluginConfig from '../../server/src/config';

/** Boot the plugin against a Strapi stand-in where everything else is healthy, and collect its warnings. */
const bootWarnings = async (config: Record<string, unknown>) => {
  const warnings: string[] = [];
  const strapi = {
    ai: { mcp: { isEnabled: () => true } },
    config: {
      get: (key: string) => {
        if (key === 'plugin::strapi-oauth-mcp-manager') return { ...pluginConfig.default, cleanupIntervalMs: 0, ...config };
        return key === 'admin.secrets.encryptionKey' ? 'encryption-key' : undefined;
      },
    },
    log: { info() {}, warn: (message: string) => warnings.push(message), error() {}, debug() {} },
    server: { use() {}, routes() {} },
    plugin: () => ({ controller: () => ({}), service: () => ({}) }),
    db: { lifecycles: { subscribe() {} } },
  } as any;
  await bootstrap({ strapi });
  return warnings;
};

test('warns at boot that verifyUrl replaces LINE verification', async () => {
  const warnings = await bootWarnings({ identityProviders: { line: { channelId: '1657000000', verifyUrl: 'http://localhost:4545/verify' } } });
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0], /identityProviders\.line\.verifyUrl/);
  assert.match(warnings[0], /http:\/\/localhost:4545\/verify replaces LINE's ID token verification/);
  assert.match(warnings[0], /only for local testing/);
});

test('no verifyUrl warning when LINE checks ID tokens itself, or LINE sign-in is off', async () => {
  assert.deepEqual(await bootWarnings({ identityProviders: { line: { channelId: '1657000000' } } }), []);
  assert.deepEqual(await bootWarnings({}), []);
});
