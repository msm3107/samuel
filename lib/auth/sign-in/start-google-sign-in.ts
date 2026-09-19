import type { GoogleSignInResult } from "@/lib/auth/sign-in/result-codes";
import { callbackUrl } from "@/lib/auth/sign-in/urls";
import { createSessionClient } from "@/lib/database/session-client";
import { serverEnv } from "@/lib/env/server-env";
import { logger } from "@/lib/logging/logger";
import {
  consumeRateLimit,
  RateLimitUnavailableError,
} from "@/lib/security/rate-limit";

/**
 * Starts a PKCE Google sign-in and returns the provider URL to navigate to.
 *
 * The URL is checked against the configured Supabase origin before it is
 * returned, so this can never become a redirect to an arbitrary site.
 * Must run where cookies can be written: the PKCE verifier is stored now.
 *
 * The client network's limit is consumed before Supabase Auth is called
 * (TASK-003c), and if the limiter cannot answer, sign-in is unavailable
 * rather than unmetered.
 */
export async function startGoogleSignIn(
  network: string,
): Promise<GoogleSignInResult> {
  try {
    if (!(await consumeRateLimit("googleStartNetwork", network))) {
      logger.warn({ event: "rate_limited", limit: "googleStartNetwork" });
      return { status: "rate_limited" };
    }
  } catch (error) {
    if (!(error instanceof RateLimitUnavailableError)) {
      throw error;
    }
    logger.error({ event: "google_sign_in_limiter_unavailable" });
    return { status: "unavailable" };
  }

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
