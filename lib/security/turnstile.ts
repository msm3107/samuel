import "server-only";

import { z } from "zod";

import { serverEnv, TURNSTILE_TEST_SECRET_KEYS } from "@/lib/env/server-env";
import { logger } from "@/lib/logging/logger";

export const TURNSTILE_VERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** The field the widget adds to the form it sits in. */
export const TURNSTILE_RESPONSE_FIELD = "cf-turnstile-response";

/** Set on the widget, and required in the verified answer. */
export const MAGIC_LINK_ACTION = "magic_link";

const VERIFY_TIMEOUT_MS = 5000;

/** Cloudflare's documented maximum token length. */
const tokenSchema = z.string().min(1).max(2048);

const siteverifySchema = z.object({
  success: z.boolean(),
  hostname: z.string().optional(),
  action: z.string().optional(),
  "error-codes": z.array(z.string()).default([]),
  // Present when a test secret verified the token. Observed 2026-09-19:
  // siteverify answers the test secret with hostname "example.com", no
  // action, and this flag, although Cloudflare's docs say "localhost" and
  // "test".
  metadata: z
    .object({ result_with_testing_key: z.boolean().optional() })
    .optional(),
});

/** Codes that mean our configuration or Cloudflare failed, not the visitor. */
const SERVICE_FAILURE_CODES: ReadonlySet<string> = new Set([
  "missing-input-secret",
  "invalid-input-secret",
  "bad-request",
  "internal-error",
]);

/** Turnstile could not be consulted; the request is refused, not let through. */
export class TurnstileUnavailableError extends Error {
  override readonly name = "TurnstileUnavailableError";
}

/**
 * Verifies a Turnstile token with Cloudflare. Resolves true only when
 * Cloudflare accepts it for this application's hostname and the magic-link
 * action; false when the visitor's token is refused. Throws
 * `TurnstileUnavailableError` when Cloudflare cannot be asked or answers
 * with something unreadable.
 *
 * No IP address is sent: Cloudflare already saw the visitor when the widget
 * ran, and the token is single-use.
 */
export async function verifyTurnstileToken(token: unknown): Promise<boolean> {
  const parsed = tokenSchema.safeParse(token);
  if (!parsed.success) {
    return false;
  }

  const { TURNSTILE_SECRET_KEY, NEXT_PUBLIC_APP_URL } = serverEnv();

  let response: Response;
  try {
    response = await fetch(TURNSTILE_VERIFY_URL, {
      method: "POST",
      body: new URLSearchParams({
        secret: TURNSTILE_SECRET_KEY,
        response: parsed.data,
      }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
  } catch (error) {
    throw new TurnstileUnavailableError("siteverify unreachable", {
      cause: error,
    });
  }
  if (!response.ok) {
    throw new TurnstileUnavailableError(
      `siteverify answered ${response.status}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new TurnstileUnavailableError("siteverify answer unreadable", {
      cause: error,
    });
  }
  const answer = siteverifySchema.safeParse(body);
  if (!answer.success) {
    throw new TurnstileUnavailableError("siteverify answer malformed");
  }

  const errorCodes = answer.data["error-codes"];
  if (!answer.data.success) {
    if (errorCodes.some((code) => SERVICE_FAILURE_CODES.has(code))) {
      throw new TurnstileUnavailableError(
        `siteverify refused the request: ${errorCodes.join(",")}`,
      );
    }
    logger.info({ event: "turnstile_token_refused", errorCodes });
    return false;
  }

  const testedWithTestKey =
    answer.data.metadata?.result_with_testing_key === true;
  if (TURNSTILE_TEST_SECRET_KEYS.has(TURNSTILE_SECRET_KEY)) {
    // A test secret is accepted only on a loopback application URL
    // (lib/env/server-env.ts). Its answers carry no real hostname or action,
    // so the flag is all there is to check.
    return testedWithTestKey;
  }

  const expectedHostname = new URL(NEXT_PUBLIC_APP_URL).hostname;
  if (
    testedWithTestKey ||
    answer.data.action !== MAGIC_LINK_ACTION ||
    answer.data.hostname !== expectedHostname
  ) {
    // A token solved on another site, or for another action on this one.
    logger.warn({ event: "turnstile_token_mismatch" });
    return false;
  }
  return true;
}
