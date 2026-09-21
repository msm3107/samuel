export type AuthenticationFailureCode =
  | "session_missing"
  | "session_invalid"
  // Past the 7-day limit since the last sign-in (TASK-003h).
  | "session_expired";

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

/**
 * The signed-in user may not do this in this organization. One code for every
 * cause — not a member, a role too low, an organization that does not exist
 * or was deleted, an unusable ID — so the response cannot reveal which
 * organizations exist. The cause is logged server-side, never carried here.
 */
export class AuthorizationError extends Error {
  override readonly name = "AuthorizationError";
  readonly code = "organization_access_denied";

  constructor() {
    super("Not permitted in this organization");
  }
}

/**
 * The membership could not be read, so no decision was made either way. Kept
 * apart from AuthorizationError so a database outage surfaces as an error
 * with a reference code rather than as "access denied"; both fail closed.
 */
export class MembershipLookupError extends Error {
  override readonly name = "MembershipLookupError";
  readonly code = "membership_lookup_failed";

  constructor(options?: ErrorOptions) {
    super("The organization membership could not be verified", options);
  }
}
