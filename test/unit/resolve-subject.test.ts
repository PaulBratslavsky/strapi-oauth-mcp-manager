import assert from 'node:assert/strict';
import { test } from 'node:test';
import pluginConfig from '../../server/src/config';
import oauthService from '../../server/src/services/oauth';
import { hashToken } from '../../server/src/utils/crypto';

const SUBJECT = 'line:U4af4980629c1a7b3f1e2d3c4b5a69788';
const inAnHour = new Date(Date.now() + 3600_000).toISOString();
const anHourAgo = new Date(Date.now() - 3600_000).toISOString();

/** Grants by access token; the fake database only allows reads. */
const serviceWith = (grants: Record<string, { subject: string | null; expiresAt: string }>) => {
  const lookups: string[] = [];
  const rows = Object.entries(grants).map(([token, grant], index) => ({ id: index + 1, accessTokenHash: hashToken(token), ...grant }));
  const strapi = {
    config: { get: () => pluginConfig.default },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    db: {
      query: () => ({
        findOne: async ({ where }: any) => {
          lookups.push(where.accessTokenHash);
          return rows.find((row) => row.accessTokenHash === where.accessTokenHash) ?? null;
        },
      }),
    },
  } as any;
  return { service: oauthService({ strapi }), lookups };
};

test("returns the customer's subject for a live customer session", async () => {
  const { service } = serviceWith({ mcp_at_customer: { subject: SUBJECT, expiresAt: inAnHour } });
  assert.equal(await service.resolveSubject('Bearer mcp_at_customer'), SUBJECT);
  assert.equal(await service.resolveSubject('bearer mcp_at_customer'), SUBJECT, 'the scheme is case-insensitive, as in the middleware');
});

test('returns null for staff sessions, expired sessions and unknown tokens', async () => {
  const { service } = serviceWith({
    mcp_at_staff: { subject: null, expiresAt: inAnHour },
    mcp_at_expired: { subject: SUBJECT, expiresAt: anHourAgo },
  });
  assert.equal(await service.resolveSubject('Bearer mcp_at_staff'), null);
  assert.equal(await service.resolveSubject('Bearer mcp_at_expired'), null);
  assert.equal(await service.resolveSubject('Bearer mcp_at_unknown'), null);
});

test('returns null without a lookup for anything that is not one bearer session token', async () => {
  const { service, lookups } = serviceWith({ mcp_at_customer: { subject: SUBJECT, expiresAt: inAnHour } });
  for (const header of [undefined, '', 'Bearer', 'Basic bWNwOnNlY3JldA==', 'Bearer strapi-admin-token-value', ['Bearer mcp_at_customer', 'Bearer mcp_at_customer']] as const) {
    assert.equal(await service.resolveSubject(header as any), null, JSON.stringify(header));
  }
  assert.deepEqual(lookups, [], 'no database lookups');
});
