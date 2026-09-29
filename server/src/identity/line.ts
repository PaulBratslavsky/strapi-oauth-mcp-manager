import { OAuthError } from '../utils/oauth-error';
import type { IdentityProvider } from './types';

export const LINE_VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';

const LINE_USER_ID = /^U[0-9a-f]{32}$/;
const TIMEOUT_MS = 5000;

const invalid = () => new OAuthError('invalid_grant', 'The LINE ID token is invalid or expired');
const unavailable = () =>
  new OAuthError('temporarily_unavailable', 'LINE sign-in could not be checked right now. Try again shortly.', 503);

/** Verifies LINE ID tokens with LINE's verify endpoint. */
export const createLineProvider = (
  settings: { channelId: string; verifyUrl?: string },
  fetchImpl: typeof fetch = fetch
): IdentityProvider => ({
  id: 'line',
  async verify(idToken: string) {
    let response: Response;
    try {
      response = await fetchImpl(settings.verifyUrl ?? LINE_VERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ id_token: idToken, client_id: settings.channelId }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw unavailable();
    }
    if (response.status >= 500) {
      throw unavailable();
    }
    if (!response.ok) {
      throw invalid();
    }

    let claims: { sub?: unknown; aud?: unknown; exp?: unknown };
    try {
      claims = await response.json();
    } catch {
      throw unavailable();
    }
    const expiresAt = typeof claims.exp === 'number' ? new Date(claims.exp * 1000) : null;
    const valid =
      claims.aud === settings.channelId &&
      expiresAt !== null &&
      expiresAt.getTime() > Date.now() &&
      typeof claims.sub === 'string' &&
      LINE_USER_ID.test(claims.sub);
    if (!valid) {
      throw invalid();
    }
    return { subject: `line:${claims.sub}`, expiresAt };
  },
});
