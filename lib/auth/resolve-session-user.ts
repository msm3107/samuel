import {
  isAuthApiError,
  isAuthSessionMissingError,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { z } from "zod";

import {
  SessionLookupError,
  type AuthenticationFailureCode,
} from "@/lib/auth/errors";
import { isSessionExpired } from "@/lib/auth/session-age";
import { logger } from "@/lib/logging/logger";

export type SessionResolution =
  | { status: "authenticated"; userId: string }
  | { status: "unauthenticated"; reason: AuthenticationFailureCode };

const userIdSchema = z.uuid();

/**
 * The statuses GoTrue uses to refuse a credential: 400 for a rejected refresh
 * token, 401 and 403 for a bad or revoked access token. Any other status says
 * nothing about the credential — a 404 or 408 from a misconfigured gateway must
 * not sign every user out — so it fails closed as a lookup failure instead.
 */
const CREDENTIAL_REJECTION_STATUSES: ReadonlySet<number> = new Set([
  400, 401, 403,
]);

/**
 * Asks the auth server — not the cookie — who the session belongs to.
 *
 * `getSession()` reads the cookie and refreshes an expired access token; it
 * trusts the cookie's contents, so it decides nothing. `getUser(jwt)` then
 * validates that exact access token remotely, so a forged or revoked token is
 * rejected, and only after that are the token's own claims read: the session
 * is refused 7 days after its last sign-in (TASK-003h).
 *
 * Shared by the proxy and `requireSession()` so both classify failures the same
 * way. It takes an auth client, never an identity.
 */
export async function resolveSessionUser(
  auth: SupabaseClient["auth"],
): Promise<SessionResolution> {
  let stored: Awaited<ReturnType<SupabaseClient["auth"]["getSession"]>>;
  try {
    stored = await auth.getSession();
  } catch (error) {
    throw new SessionLookupError({ cause: error });
  }
  if (stored.error) {
    return classifyFailure(stored.error);
  }
  const accessToken = stored.data.session?.access_token;
  if (!accessToken) {
    return { status: "unauthenticated", reason: "session_missing" };
  }

  let result: Awaited<ReturnType<SupabaseClient["auth"]["getUser"]>>;
  try {
    result = await auth.getUser(accessToken);
  } catch (error) {
    throw new SessionLookupError({ cause: error });
  }

  const { data, error } = result;

  if (error) {
    return classifyFailure(error);
  }

  // Third-party response: validated rather than trusted to be well-formed.
  const userId = userIdSchema.safeParse(data.user?.id);
  if (!userId.success) {
    throw new SessionLookupError();
  }

  // Read from the token the auth server has just accepted, never before.
  if (isSessionExpired(accessToken)) {
    logger.info({ event: "session_past_absolute_limit" });
    return { status: "unauthenticated", reason: "session_expired" };
  }

  return { status: "authenticated", userId: userId.data };
}

function classifyFailure(error: unknown): SessionResolution {
  if (isAuthSessionMissingError(error)) {
    return { status: "unauthenticated", reason: "session_missing" };
  }
  if (isRejectedCredential(error)) {
    return { status: "unauthenticated", reason: "session_invalid" };
  }
  throw new SessionLookupError({ cause: error });
}

function isRejectedCredential(error: unknown) {
  return (
    isAuthApiError(error) && CREDENTIAL_REJECTION_STATUSES.has(error.status)
  );
}
