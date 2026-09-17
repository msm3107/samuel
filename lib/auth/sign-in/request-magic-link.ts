import { isAuthApiError } from "@supabase/supabase-js";

import { parseEmail } from "@/lib/auth/sign-in/email";
import type { MagicLinkResult } from "@/lib/auth/sign-in/result-codes";
import { callbackUrl } from "@/lib/auth/sign-in/urls";
import { createSessionClient } from "@/lib/database/session-client";
import { logger } from "@/lib/logging/logger";

/**
 * Answers that must not change with whether the address is registered.
 *
 * - `over_email_send_rate_limit`: a link was already sent to this address, so
 *   the same confirmation is also the honest answer.
 * - `signup_disabled`: only an unregistered address can ever produce it, so
 *   surfacing it would say "no account here". Both are logged, because the
 *   person is waiting for mail that may not arrive.
 */
const SILENTLY_NOT_SENT_CODES: ReadonlySet<string> = new Set([
  "over_email_send_rate_limit",
  "signup_disabled",
]);

/** Supabase judged the address undeliverable. Says nothing about accounts. */
const INVALID_ADDRESS_CODES: ReadonlySet<string> = new Set([
  "email_address_invalid",
]);

/**
 * Sends a PKCE magic link. New addresses get an account, so the result is
 * identical whether or not the address was registered.
 *
 * Must run where cookies can be written (a server action or route handler):
 * the PKCE verifier is stored in a cookie now and read back by the callback.
 */
export async function requestMagicLink(
  input: unknown,
): Promise<MagicLinkResult> {
  const email = parseEmail(input);
  if (!email) {
    return "invalid_email";
  }

  const supabase = await createSessionClient();

  let error: unknown;
  try {
    ({ error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: callbackUrl(), shouldCreateUser: true },
    }));
  } catch (thrown) {
    error = thrown;
  }

  if (!error) {
    return "link_sent";
  }

  const code = isAuthApiError(error) ? error.code : undefined;
  if (code && SILENTLY_NOT_SENT_CODES.has(code)) {
    // Never the address: an operator needs to see the throttle, not who hit it.
    logger.warn({ event: "magic_link_not_sent", code });
    return "link_sent";
  }
  if (code && INVALID_ADDRESS_CODES.has(code)) {
    return "invalid_email";
  }

  // Never the address: the log records why sending failed, not for whom.
  logger.warn({
    event: "magic_link_request_failed",
    code: code ?? "none",
    status: isAuthApiError(error) ? error.status : undefined,
  });
  return "unavailable";
}
