import { parseEmail } from "@/lib/auth/sign-in/email";
import type { MagicLinkResult } from "@/lib/auth/sign-in/result-codes";
import { logger } from "@/lib/logging/logger";
import {
  consumeRateLimit,
  GLOBAL,
  RateLimitUnavailableError,
} from "@/lib/security/rate-limit";
import {
  TurnstileUnavailableError,
  verifyTurnstileToken,
} from "@/lib/security/turnstile";

export type MagicLinkGate =
  | { status: "pass"; email: string }
  | { status: "refused"; result: MagicLinkResult };

/**
 * The checks a magic-link request passes before the response floor
 * (TASK-003c). Every refusal here depends only on the request itself — its
 * format, its network, overall load — and never on whether an address has an
 * account, so answering at once reveals nothing. Answering at once also means
 * a flood of refused requests does not hold connections open for the floor.
 *
 * Order matters: the per-network cap and limit come first, so one network
 * cannot spend the global allowance. Past the per-network limit or the global
 * threshold, a request needs a Turnstile challenge; past the per-network cap,
 * it is refused (TASK-003g).
 */
export async function checkMagicLinkGate(input: {
  email: unknown;
  captchaToken: unknown;
  network: string;
}): Promise<MagicLinkGate> {
  const email = parseEmail(input.email);
  if (!email) {
    return refused("invalid_email");
  }

  try {
    if (!(await consumeRateLimit("magicLinkNetworkCap", input.network))) {
      logger.warn({ event: "rate_limited", limit: "magicLinkNetworkCap" });
      return refused("rate_limited");
    }

    // A busy shared network (an office, a mobile carrier) is asked for the
    // challenge, not refused; it spends none of the global allowance.
    if (!(await consumeRateLimit("magicLinkNetwork", input.network))) {
      return await challenge(input.captchaToken, email);
    }

    if (!(await consumeRateLimit("magicLinkGlobal", GLOBAL))) {
      // For alerting (Phase 12): sustained, this is an attack or a surge.
      // Once per window, so the attacker does not decide the error volume.
      if (await consumeRateLimit("magicLinkThresholdAlert", GLOBAL)) {
        logger.error({ event: "magic_link_global_threshold_exceeded" });
      }
      return await challenge(input.captchaToken, email);
    }
  } catch (error) {
    return unavailable(error);
  }

  return { status: "pass", email };
}

/**
 * Past the per-network limit or the global threshold, a request goes ahead
 * only with a Turnstile token Cloudflare accepts. Nobody is refused outright,
 * so a flood cannot lock everyone out; it only makes them solve a challenge.
 */
async function challenge(
  captchaToken: unknown,
  email: string,
): Promise<MagicLinkGate> {
  if (
    captchaToken === null ||
    captchaToken === undefined ||
    captchaToken === ""
  ) {
    return refused("captcha_required");
  }
  return (await verifyTurnstileToken(captchaToken))
    ? { status: "pass", email }
    : refused("captcha_failed");
}

function refused(result: MagicLinkResult): MagicLinkGate {
  return { status: "refused", result };
}

function unavailable(error: unknown): MagicLinkGate {
  if (
    !(error instanceof RateLimitUnavailableError) &&
    !(error instanceof TurnstileUnavailableError)
  ) {
    throw error;
  }
  // The name only: causes can carry request details.
  logger.error({ event: "magic_link_gate_unavailable", causeName: error.name });
  return refused("unavailable");
}
