import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { AuthenticationError } from "@/lib/auth/errors";
import { SIGN_IN_PATH } from "@/lib/auth/protected-routes";
import { resolveSessionUser } from "@/lib/auth/resolve-session-user";
import { sessionRefreshState } from "@/lib/auth/session-expiry";
import { createResolvingSessionClient } from "@/lib/database/session-client";

export type Session = Readonly<{ userId: string }>;

/**
 * The one trustworthy answer to "who is making this request".
 *
 * Identity comes only from the session cookie, validated by the auth server. It
 * takes no arguments and reads no body, query parameter, or header, so there is
 * nowhere for a caller-supplied identity to enter.
 *
 * Throws `AuthenticationError` rather than returning null, so a caller cannot
 * forget the check. Wrapped in React `cache()` so that, within one server
 * render, layouts, pages, and data access can each call it without repeating
 * the auth-server round trip. Outside a server render there is no memoization.
 */
export const requireSession = cache(async (): Promise<Session> => {
  const { supabase, applyHeldRemovals } = await createResolvingSessionClient();
  const resolution = await resolveSessionUser(supabase.auth, {
    hadStoredSession: sessionRefreshState(await cookies()) !== "none",
  });

  if (resolution.status === "unauthenticated") {
    // A verdict, so the session really is finished: let auth-js's cookie
    // removals through. A lookup failure throws instead and keeps them held,
    // so a 429 or an outage never signs anyone out (TASK-003i).
    applyHeldRemovals();
    throw new AuthenticationError(resolution.reason);
  }

  return Object.freeze({ userId: resolution.userId });
});

/**
 * For dashboard layouts and pages: an unauthenticated visitor is redirected to
 * sign-in with nothing about the requested path carried along. A lookup
 * failure is rethrown and renders as an error, never as the page.
 *
 * Layouts do not re-render on client-side navigation, so this is not the only
 * check: the proxy repeats it on every request, and data access must call
 * `requireSession()` itself.
 */
export async function requireDashboardSession(): Promise<Session> {
  try {
    return await requireSession();
  } catch (error) {
    if (error instanceof AuthenticationError) {
      redirect(SIGN_IN_PATH);
    }
    throw error;
  }
}
