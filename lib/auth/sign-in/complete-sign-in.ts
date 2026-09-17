import {
  isAuthApiError,
  isAuthPKCECodeVerifierMissingError,
} from "@supabase/supabase-js";
import { z } from "zod";

import type {
  CallbackErrorCode,
  CompleteSignInResult,
} from "@/lib/auth/sign-in/result-codes";
import { createSessionClient } from "@/lib/database/session-client";
import { logger } from "@/lib/logging/logger";

// Supabase auth codes are UUIDs today; the bound is loose enough to survive a
// format change and tight enough to reject junk before a network call.
const authCodeSchema = z
  .string()
  .min(16)
  .max(512)
  .regex(/^[A-Za-z0-9._~-]+$/);

// Matches auth-js's own PKCE flow-id pattern, so an id it would never mint is
// reported as an invalid link rather than as one opened in another browser.
const flowIdSchema = z.string().regex(/^[a-zA-Z0-9_-]{8,64}$/);

const userIdSchema = z.uuid();

/** Returned by the token exchange when the flow itself timed out. */
const EXPIRED_EXCHANGE_CODES: ReadonlySet<string> = new Set([
  "flow_state_expired",
]);

/**
 * GoTrue redirects an expired magic link back with `error_code=otp_expired`
 * and no code at all, so this arrives as a provider error rather than as an
 * exchange failure.
 */
const EXPIRED_PROVIDER_CODES: ReadonlySet<string> = new Set([
  "otp_expired",
  "flow_state_expired",
]);

/**
 * Completes a magic-link or OAuth sign-in by exchanging the PKCE code for a
 * session. The code is useless without the verifier cookie this browser
 * stored when it started the flow, which is what stops an attacker from
 * signing a victim into the attacker's account with a code of their own.
 */
export async function completeSignIn(params: {
  code: unknown;
  flowId: unknown;
  providerError: unknown;
  providerErrorCode?: unknown;
}): Promise<CompleteSignInResult> {
  if (params.providerError !== null && params.providerError !== undefined) {
    // The provider declined, the user cancelled, or the link expired before it
    // was opened. Only the machine-readable code is read; the description is
    // attacker-influenced text.
    return failed(
      typeof params.providerErrorCode === "string" &&
        EXPIRED_PROVIDER_CODES.has(params.providerErrorCode)
        ? "link_expired"
        : "sign_in_failed",
    );
  }

  const code = authCodeSchema.safeParse(params.code);
  if (!code.success) {
    return failed("link_invalid");
  }

  const flowId =
    params.flowId === null || params.flowId === undefined
      ? undefined
      : flowIdSchema.safeParse(params.flowId);
  if (flowId && !flowId.success) {
    return failed("link_invalid");
  }

  // Creating the client can itself fail (configuration, or a context that
  // cannot write cookies); inside the try, that becomes a safe redirect rather
  // than an unhandled 500 without cache headers.
  let result;
  try {
    const supabase = await createSessionClient();
    result = await supabase.auth.exchangeCodeForSession(
      code.data,
      flowId?.success ? { flowId: flowId.data } : undefined,
    );
  } catch (error) {
    return failedWithLog(error, "sign_in_unavailable");
  }

  if (result.error) {
    return failedWithLog(result.error, classifyExchangeError(result.error));
  }

  // Third-party response: a session is only trusted if it names a real user.
  if (!userIdSchema.safeParse(result.data.user?.id).success) {
    return failedWithLog(undefined, "sign_in_unavailable");
  }

  return { status: "signed-in" };
}

function classifyExchangeError(error: unknown): CallbackErrorCode {
  if (isAuthPKCECodeVerifierMissingError(error)) {
    return "link_other_browser";
  }
  if (isAuthApiError(error)) {
    if (error.code && EXPIRED_EXCHANGE_CODES.has(error.code)) {
      return "link_expired";
    }
    if (error.status >= 400 && error.status < 500 && error.status !== 429) {
      return "link_invalid";
    }
  }
  return "sign_in_unavailable";
}

function failed(code: CallbackErrorCode): CompleteSignInResult {
  return { status: "failed", code };
}

function failedWithLog(
  error: unknown,
  code: CallbackErrorCode,
): CompleteSignInResult {
  // Error name and code only: messages can quote the auth code.
  logger.warn({
    event: "sign_in_callback_failed",
    code,
    causeName: error instanceof Error ? error.name : "none",
    causeCode: isAuthApiError(error) ? (error.code ?? "none") : "none",
  });
  return failed(code);
}
