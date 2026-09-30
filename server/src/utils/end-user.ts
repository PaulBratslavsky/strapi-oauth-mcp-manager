import { OAuthError } from './oauth-error';

export const GRANT_TYPE_TOKEN_EXCHANGE = 'urn:ietf:params:oauth:grant-type:token-exchange';
export const TOKEN_TYPE_ID_TOKEN = 'urn:ietf:params:oauth:token-type:id_token';
export const TOKEN_TYPE_ACCESS_TOKEN = 'urn:ietf:params:oauth:token-type:access_token';

/** Who signs in through a client: staff with a Strapi admin account ("none"), or customers with LINE. */
export type EndUserProvider = 'none' | 'line';

/** Client rows created before 1.1 read back as null: they are staff clients. */
export const endUserProviderOf = (value: unknown): EndUserProvider => (value === 'line' ? 'line' : 'none');

/** "line:U4af4980629c1a7b3f1e2d3c4b5a69788" → "line:U4af…88", for logs and the admin page. */
export const maskSubject = (subject: string | null | undefined): string | null => {
  if (!subject) return null;
  const separator = subject.indexOf(':');
  const provider = subject.slice(0, separator + 1);
  const id = subject.slice(separator + 1);
  return id.length <= 6 ? `${provider}…` : `${provider}${id.slice(0, 4)}…${id.slice(-2)}`;
};

export interface ClientInput {
  endUserProvider: EndUserProvider;
  confidential: boolean;
  redirectUris: string[];
  adminTokenId: number | null;
}

/**
 * Staff clients need a redirect URI for the consent flow. LINE clients run in the customer's
 * app, which can't keep a secret, so they are public. They need a mapped admin token because
 * every customer session runs with it, and they may have no redirect URI: token exchange has none.
 */
export const applyClientRules = (input: ClientInput): ClientInput => {
  if (input.endUserProvider === 'line') {
    if (!input.adminTokenId) {
      throw new OAuthError(
        'invalid_request',
        'A LINE client needs a mapped admin token: every customer session runs with its permissions.'
      );
    }
    return { ...input, confidential: false };
  }
  if (input.redirectUris.length === 0) {
    throw new OAuthError('invalid_request', 'At least one redirect URI is required');
  }
  return input;
};

/** A LINE client's token can be swapped but never removed. */
export const assertCanSetClientToken = (endUserProvider: EndUserProvider, adminTokenId: number | null) => {
  if (endUserProvider === 'line' && adminTokenId === null) {
    throw new OAuthError(
      'invalid_request',
      'A LINE client must keep a mapped admin token. Map another token, or deactivate the client.'
    );
  }
};

/** LINE clients only use token exchange, and only LINE clients may use it. */
export const assertGrantTypeAllowed = (endUserProvider: EndUserProvider, grantType: string) => {
  const exchange = grantType === GRANT_TYPE_TOKEN_EXCHANGE;
  if (endUserProvider === 'line' && !exchange) {
    throw new OAuthError('unauthorized_client', 'This client signs customers in with LINE and can only use token exchange');
  }
  if (endUserProvider !== 'line' && exchange) {
    throw new OAuthError('unauthorized_client', 'This client is not set up for LINE sign-in');
  }
};
