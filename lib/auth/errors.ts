export type AuthenticationFailureCode = "session_missing" | "session_invalid";

/**
 * No trustworthy session: absent, expired beyond refresh, revoked, or
 * tampered. Callers redirect to sign-in; they never render a partial page.
 */
export class AuthenticationError extends Error {
  override readonly name = "AuthenticationError";

  constructor(readonly code: AuthenticationFailureCode) {
    super(`Authentication required (${code})`);
  }
}

/**
 * The session could not be verified either way: network failure, 5xx, rate
 * limiting, an unexpected status, a malformed user response, or a token the
 * client library refused to send. Distinct from AuthenticationError because
 * sending a signed-in user to sign-in during an outage would loop; the request
 * still fails closed, as an error rather than a redirect.
 *
 * Which refresh failures count as a signed-out session is decided by
 * `@supabase/auth-js`, not here.
 */
export class SessionLookupError extends Error {
  override readonly name = "SessionLookupError";
  readonly code = "session_lookup_failed";

  constructor(options?: ErrorOptions) {
    super("The session could not be verified", options);
  }
}
