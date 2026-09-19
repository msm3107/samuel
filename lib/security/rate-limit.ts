import "server-only";

import { createHmac } from "node:crypto";

import { z } from "zod";

import { createServiceRoleClient } from "@/lib/database/service-role-client";
import { serverEnv } from "@/lib/env/server-env";

type RateLimit = {
  /** Part of the HMAC input, so equal values in different limits never share a bucket. */
  scope: string;
  limit: number;
  windowSeconds: number;
  /** Minimum time between allowed hits; 0 for none. */
  minIntervalSeconds: number;
};

/**
 * Every application rate limit, in one reviewed place (TASK-003c). "Network"
 * values come from `clientNetwork` (an IPv4 address or an IPv6 /64).
 */
export const RATE_LIMITS = {
  magicLinkNetwork: {
    scope: "magic_link:network",
    limit: 5,
    windowSeconds: 10 * 60,
    minIntervalSeconds: 0,
  },
  // At least 60 s apart, as GoTrue's `auth.email.max_frequency`, so the app
  // never forwards a request GoTrue would refuse: a refused request makes
  // auth-js delete the verifier a link already sent needs (review finding F1).
  magicLinkAddress: {
    scope: "magic_link:address",
    limit: 3,
    windowSeconds: 10 * 60,
    minIntervalSeconds: 60,
  },
  // Past this, the form asks for a Turnstile challenge rather than refusing
  // everyone.
  magicLinkGlobal: {
    scope: "magic_link:global",
    limit: 200,
    windowSeconds: 60 * 60,
    minIntervalSeconds: 0,
  },
  googleStartNetwork: {
    scope: "google_start:network",
    limit: 10,
    windowSeconds: 10 * 60,
    minIntervalSeconds: 0,
  },
  callbackNetwork: {
    scope: "callback:network",
    limit: 20,
    windowSeconds: 10 * 60,
    minIntervalSeconds: 0,
  },
  // Consumed by the proxy (TASK-003f).
  sessionRefreshNetwork: {
    scope: "session_refresh:network",
    limit: 30,
    windowSeconds: 5 * 60,
    minIntervalSeconds: 0,
  },
} as const satisfies Record<string, RateLimit>;

export type RateLimitName = keyof typeof RATE_LIMITS;

/** The value every request shares in a global limit. */
export const GLOBAL = "global";

/**
 * The limiter could not be consulted. Callers refuse the request rather than
 * let it through unmetered: a limit that disappears when the database is slow
 * protects nothing.
 */
export class RateLimitUnavailableError extends Error {
  override readonly name = "RateLimitUnavailableError";
}

/**
 * The bucket key: HMAC-SHA256 of `<scope>:<value>` under a server secret, as
 * lowercase hex. The database stores only this, so it holds no email or IP
 * address, and the digest cannot be reversed by hashing guesses without the
 * secret.
 */
export function rateLimitKey(
  scope: string,
  value: string,
  secret: string = serverEnv().RATE_LIMIT_HMAC_SECRET,
): string {
  return createHmac("sha256", secret).update(`${scope}:${value}`).digest("hex");
}

/**
 * Consumes one hit from `value`'s bucket in the named limit. Resolves true when
 * the hit was allowed and false when the limit was reached; a refused hit is
 * not counted. Throws `RateLimitUnavailableError` if the database cannot
 * answer.
 *
 * Uses the service-role client because no session can do this: the function
 * is granted to `service_role` only, so the anon key can neither read nor
 * exhaust a bucket.
 */
export async function consumeRateLimit(
  name: RateLimitName,
  value: string,
): Promise<boolean> {
  const { scope, limit, windowSeconds, minIntervalSeconds } = RATE_LIMITS[name];

  let response: { data: unknown; error: unknown };
  try {
    response = await createServiceRoleClient().rpc("consume_rate_limit", {
      p_key: rateLimitKey(scope, value),
      p_limit: limit,
      p_window_seconds: windowSeconds,
      p_min_interval_seconds: minIntervalSeconds,
    });
  } catch (error) {
    throw new RateLimitUnavailableError(`rate limit ${name} unavailable`, {
      cause: error,
    });
  }

  if (response.error) {
    throw new RateLimitUnavailableError(`rate limit ${name} unavailable`, {
      cause: response.error,
    });
  }
  const allowed = z.boolean().safeParse(response.data);
  if (!allowed.success) {
    throw new RateLimitUnavailableError(`rate limit ${name} answered badly`);
  }
  return allowed.data;
}
