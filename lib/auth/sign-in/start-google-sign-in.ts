import type { GoogleSignInResult } from "@/lib/auth/sign-in/result-codes";
import { callbackUrl } from "@/lib/auth/sign-in/urls";
import { createSessionClient } from "@/lib/database/session-client";
import { serverEnv } from "@/lib/env/server-env";
import { logger } from "@/lib/logging/logger";

/**
 * Starts a PKCE Google sign-in and returns the provider URL to navigate to.
 *
 * The URL is checked against the configured Supabase origin before it is
 * returned, so this can never become a redirect to an arbitrary site.
 * Must run where cookies can be written: the PKCE verifier is stored now.
 */
export async function startGoogleSignIn(): Promise<GoogleSignInResult> {
  const supabase = await createSessionClient();

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: callbackUrl(), skipBrowserRedirect: true },
  });

  if (error || !data.url) {
    logger.warn({
      event: "google_sign_in_start_failed",
      code: error?.code ?? "none",
    });
    return { status: "unavailable" };
  }

  if (!isSupabaseUrl(data.url)) {
    logger.error({ event: "google_sign_in_unexpected_origin" });
    return { status: "unavailable" };
  }

  return { status: "redirect", url: data.url };
}

function isSupabaseUrl(candidate: string) {
  try {
    return (
      new URL(candidate).origin === new URL(serverEnv().SUPABASE_URL).origin
    );
  } catch {
    return false;
  }
}
