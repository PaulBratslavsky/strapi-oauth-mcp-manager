import { PLUGIN_ID } from '../pluginId';
import { OAuthError } from '../utils/oauth-error';
import type { IdentityProvider, ProviderLog } from './types';

export const LINE_VERIFY_URL = 'https://api.line.me/oauth2/v2.1/verify';

const LINE_USER_ID = /^U[0-9a-f]{32}$/;
const TIMEOUT_MS = 5000;
/** 4xx answers that mean "not now" rather than "bad token": the request timed out, or LINE is rate limiting. */
const TRY_LATER_STATUSES = new Set([408, 429]);

const invalid = () => new OAuthError('invalid_grant', 'The LINE ID token is invalid or expired');

/** Why the request to LINE failed, from the error's name and code only (never the request body). */
const describeFetchError = (error: unknown) => {
  const { name, message, cause } = (error ?? {}) as { name?: string; message?: string; cause?: { code?: string } };
  if (name === 'TimeoutError') {
    return `no answer within ${TIMEOUT_MS / 1000} seconds`;
  }
  return `the request failed (${cause?.code ?? message ?? 'unknown error'})`;
};

/** Verifies LINE ID tokens with LINE's verify endpoint. */
export const createLineProvider = (
  settings: { channelId: string; verifyUrl?: string },
  fetchImpl: typeof fetch = fetch,
  log: ProviderLog = { warn() {} }
): IdentityProvider => {
  const verifyUrl = settings.verifyUrl ?? LINE_VERIFY_URL;

  /** LINE gave no usable answer. The app may try again; the operator learns why. */
  const unavailable = (reason: string) => {
    log.warn(`[${PLUGIN_ID}] Could not verify a LINE ID token with ${verifyUrl}: ${reason}`);
    return new OAuthError('temporarily_unavailable', 'LINE sign-in could not be checked right now. Try again shortly.', 503);
  };

  return {
    id: 'line',
    async verify(idToken: string) {
      let response: Response;
      try {
        response = await fetchImpl(verifyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ id_token: idToken, client_id: settings.channelId }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        throw unavailable(describeFetchError(error));
      }
      if (response.status >= 500 || TRY_LATER_STATUSES.has(response.status)) {
        throw unavailable(`LINE answered HTTP ${response.status}`);
      }
      if (!response.ok) {
        throw invalid();
      }

      let claims: { sub?: unknown; aud?: unknown; exp?: unknown };
      try {
        claims = await response.json();
      } catch {
        throw unavailable(`LINE's answer (HTTP ${response.status}) was not JSON`);
      }
      if (typeof claims !== 'object' || claims === null) {
        throw unavailable(`LINE's answer (HTTP ${response.status}) was not a JSON object`);
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
  };
};
