import { cookies } from "next/headers";

import { sessionCookieName } from "@/lib/auth/session-expiry";
import {
  createSessionClient,
  removeSessionCookies,
} from "@/lib/database/session-client";
import { logger } from "@/lib/logging/logger";

/**
 * Revokes this browser's session on the auth server and clears its cookies.
 * auth-js clears the local session even when the revoke call fails, so a
 * browser is signed out either way; the failure is logged because the refresh
 * token may still be live server-side.
 *
 * Scope is `local`: signing out on one device does not sign the person out
 * everywhere.
 *
 * The cookies are then removed directly as well, so sign-out works even when
 * auth-js has no session to remove — the proxy hides the session from a
 * request whose refresh is over the limit (TASK-003f), and a person must
 * always be able to sign out (TASK-003i).
 */
export async function signOut(): Promise<void> {
  const supabase = await createSessionClient();
  const { error } = await supabase.auth.signOut({ scope: "local" });

  if (error) {
    logger.warn({
      event: "sign_out_revoke_failed",
      causeName: error.name,
      causeCode: error.code ?? "none",
    });
  }

  removeSessionCookies(await cookies(), sessionCookieName());
}
