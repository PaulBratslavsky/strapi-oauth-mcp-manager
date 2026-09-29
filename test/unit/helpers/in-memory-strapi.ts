// A Strapi stand-in for service tests: plugin config, recorded logs, and an in-memory Query Engine
// that supports what the oauth service uses (equality, $in, $lt, $or, relation filters, select).
import pluginConfig from '../../../server/src/config';
import { PLUGIN_ID } from '../../../server/src/pluginId';

const UID = {
  client: `plugin::${PLUGIN_ID}.mcp-oauth-client`,
  code: `plugin::${PLUGIN_ID}.mcp-oauth-code`,
  grant: `plugin::${PLUGIN_ID}.mcp-oauth-token`,
} as const;

type Row = Record<string, any>;

const matchesCondition = (value: any, condition: any): boolean => {
  if (condition === null) return value === null || value === undefined;
  if (typeof condition === 'object' && !Array.isArray(condition)) {
    if ('$in' in condition) return condition.$in.includes(value);
    if ('$lt' in condition) return value < condition.$lt;
    // A relation filter such as { adminUserOwner: { id: 1 } }.
    return value !== null && typeof value === 'object' && matches(value, condition);
  }
  return value === condition;
};

const matches = (row: Row, where: Row = {}): boolean =>
  Object.entries(where).every(([key, condition]) =>
    key === '$or' ? (condition as Row[]).some((alternative) => matches(row, alternative)) : matchesCondition(row[key], condition)
  );

const pick = (row: Row, select?: string[], populate?: string[] | Row) => {
  if (!select) return { ...row };
  const keys = [...select, ...(Array.isArray(populate) ? populate : Object.keys(populate ?? {}))];
  return Object.fromEntries(keys.filter((key) => key in row).map((key) => [key, row[key]]));
};

interface TableHooks {
  /** Runs after findMany has read its rows and before it returns them (a stale read, as in a real race). */
  afterFindMany?: (where: Row | undefined) => Promise<void>;
}

const table = (rows: Row[], hooks: TableHooks = {}) => {
  let nextId = rows.reduce((max, row) => Math.max(max, row.id ?? 0), 0) + 1;
  return {
    async findOne({ where, select, populate }: Row = {}) {
      const row = rows.find((candidate) => matches(candidate, where));
      return row ? pick(row, select, populate) : null;
    },
    async findMany({ where, select, populate }: Row = {}) {
      const found = rows.filter((row) => matches(row, where)).map((row) => pick(row, select, populate));
      await hooks.afterFindMany?.(where);
      return found;
    },
    async count({ where }: Row = {}) {
      return rows.filter((row) => matches(row, where)).length;
    },
    async create({ data }: Row) {
      const row = { id: nextId++, ...data };
      rows.push(row);
      return { ...row };
    },
    async update({ where, data }: Row) {
      const row = rows.find((candidate) => matches(candidate, where));
      if (!row) return null;
      Object.assign(row, data);
      return { ...row };
    },
    async updateMany({ where, data }: Row) {
      const found = rows.filter((row) => matches(row, where));
      found.forEach((row) => Object.assign(row, data));
      return { count: found.length };
    },
    async delete({ where }: Row) {
      const index = rows.findIndex((row) => matches(row, where));
      return index < 0 ? null : rows.splice(index, 1)[0];
    },
    async deleteMany({ where }: Row) {
      let count = 0;
      for (let index = rows.length - 1; index >= 0; index--) {
        if (matches(rows[index], where)) {
          rows.splice(index, 1);
          count++;
        }
      }
      return { count };
    },
  };
};

export interface InMemoryWorld {
  config?: Row;
  clients?: Row[];
  grants?: Row[];
  codes?: Row[];
  users?: Row[];
  /** Admin tokens; `adminUserOwner` is `{ id }` and `accessKey` is the decrypted key. */
  apiTokens?: Row[];
  hooks?: { clients?: TableHooks; grants?: TableHooks };
}

export const inMemoryStrapi = (world: InMemoryWorld = {}) => {
  const rows = {
    clients: world.clients ?? [],
    grants: world.grants ?? [],
    codes: world.codes ?? [],
    users: world.users ?? [],
    apiTokens: world.apiTokens ?? [],
  };
  const tables: Record<string, ReturnType<typeof table>> = {
    [UID.client]: table(rows.clients, world.hooks?.clients),
    [UID.grant]: table(rows.grants, world.hooks?.grants),
    [UID.code]: table(rows.codes),
    'admin::user': table(rows.users),
    'admin::api-token': table(rows.apiTokens),
  };
  const logs = { info: [] as string[], warn: [] as string[], error: [] as string[], debug: [] as string[] };
  const apiTokenAdmin = {
    async getById(id: number, options: { includeDecryptedKey?: boolean } = {}) {
      const token = rows.apiTokens.find((row) => row.id === id);
      if (!token) return null;
      const { accessKey, ...rest } = token;
      return options.includeDecryptedKey ? { ...rest, accessKey } : rest;
    },
    async revoke(id: number) {
      await tables['admin::api-token'].delete({ where: { id } });
    },
  };
  const strapi = {
    config: {
      get: (key: string) => (key === `plugin::${PLUGIN_ID}` ? { ...pluginConfig.default, ...world.config } : undefined),
    },
    log: {
      info: (message: string) => logs.info.push(message),
      warn: (message: string) => logs.warn.push(message),
      error: (message: string) => logs.error.push(message),
      debug: (message: string) => logs.debug.push(message),
    },
    db: {
      query: (uid: string) => {
        if (!tables[uid]) throw new Error(`unexpected query for ${uid}`);
        return tables[uid];
      },
    },
    service: (name: string) => (name === 'admin::api-token-admin' ? apiTokenAdmin : undefined),
  } as any;
  return { strapi, logs, ...rows };
};

/** Everything a test might log, for "never logged" assertions. */
export const allLogs = (logs: Record<string, string[]>) => Object.values(logs).flat().join('\n');

const LINE_CONFIG = { identityProviders: { line: { channelId: '1657000000', verifyUrl: 'http://line.test/verify' } } };
export const LINE_SUB = 'U4af4980629c1a7b3f1e2d3c4b5a69788';

/**
 * One active LINE client (id 1) mapped to admin token 7, owned by an active admin (id 1).
 * Token 8 belongs to the same admin, so tests can re-map the client to it. `config` overrides
 * are merged into the LINE configuration; other overrides replace the defaults.
 */
export const lineWorld = ({ config, ...overrides }: InMemoryWorld = {}) =>
  inMemoryStrapi({
    config: { ...LINE_CONFIG, ...config },
    clients: [
      {
        id: 1,
        name: 'Maison app',
        clientId: 'mcp_client_line',
        clientSecret: null,
        redirectUris: [],
        tokenEndpointAuthMethod: 'none',
        registrationType: 'manual',
        adminTokenId: 7,
        endUserProvider: 'line',
        active: true,
      },
    ],
    users: [{ id: 1, email: 'owner@example.com', isActive: true, blocked: false }],
    apiTokens: [
      { id: 7, kind: 'admin', name: 'Customers', adminUserOwner: { id: 1 }, accessKey: 'key-customers', encryptedKey: 'x', expiresAt: null },
      { id: 8, kind: 'admin', name: 'Customers (narrow)', adminUserOwner: { id: 1 }, accessKey: 'key-narrow', encryptedKey: 'x', expiresAt: null },
    ],
    ...overrides,
  });

/** A fetch stub for LINE's verify endpoint that accepts any ID token for `sub`, optionally acting while "LINE" answers. */
export const lineVerifies = (sub = LINE_SUB, during?: () => Promise<void>) =>
  (async (_url: string, init: RequestInit) => {
    await during?.();
    const form = new URLSearchParams(String(init.body));
    const claims = { iss: 'https://access.line.me', aud: form.get('client_id'), sub, exp: Math.floor(Date.now() / 1000) + 3600 };
    return new Response(JSON.stringify(claims), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as unknown as typeof fetch;
