/** An OAuth error response (RFC 6749 §5.2). `status` is the HTTP status to send. */
export class OAuthError extends Error {
  constructor(
    public error: string,
    public description: string,
    public status = 400
  ) {
    super(description);
  }

  toJSON() {
    return { error: this.error, error_description: this.description };
  }
}
