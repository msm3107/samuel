import { createSessionClient } from "@/lib/database/session-client";
import { logger } from "@/lib/logging/logger";

/**
 * Revokes this browser's session on the auth server and clears its cookies.
 * auth-js clears the local session even when the revoke call fails, so a
 * browser is signed out either way; the failure is logged because the refresh
 * token may still be live server-side.
 *
 * Scope is `local`: signing out on one device does not sign the person out
 * everywhere.
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
}
