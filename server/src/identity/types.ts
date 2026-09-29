export interface VerifiedIdentity {
  /** Provider-scoped subject, e.g. "line:U4af4980629c1a7b3f1e2d3c4b5a69788". */
  subject: string;
  /** When the presented ID token expires. */
  expiresAt: Date;
}

export interface IdentityProvider {
  id: 'line';
  /** Throws OAuthError: invalid_grant for a bad token, temporarily_unavailable (503) when the provider can't answer. */
  verify(idToken: string): Promise<VerifiedIdentity>;
}
