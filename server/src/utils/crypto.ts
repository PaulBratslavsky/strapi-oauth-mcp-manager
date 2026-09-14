import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOKEN_PREFIX = {
  accessToken: 'mcp_at_',
  refreshToken: 'mcp_rt_',
  code: 'mcp_code_',
  clientId: 'mcp_client_',
  clientSecret: 'mcp_secret_',
} as const;

export const generateToken = (prefix: string, bytes = 32) =>
  `${prefix}${randomBytes(bytes).toString('base64url')}`;

/** Codes and tokens are stored as SHA-256 hashes, never in plaintext. */
export const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');

export const safeEqual = (a: string, b: string) => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
};

/** RFC 7636: BASE64URL(SHA256(code_verifier)) must equal the stored code_challenge. */
export const verifyPkce = (codeVerifier: string, codeChallenge: string) => {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(codeVerifier)) {
    return false;
  }
  const computed = createHash('sha256').update(codeVerifier).digest('base64url');
  return safeEqual(computed, codeChallenge);
};
