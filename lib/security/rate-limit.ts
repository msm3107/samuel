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
  // Past this, a network is asked for the Turnstile challenge rather than
  // refused: offices and mobile carriers put many people behind one address
  // (project owner, 2026-09-19; TASK-003g).
  magicLinkNetwork: {
    scope: "magic_link:network",
    limit: 5,
    windowSeconds: 10 * 60,
    minIntervalSeconds: 0,
  },
  // Past this, the network is refused, challenge or not.
  magicLinkNetworkCap: {
    scope: "magic_link:network_cap",
    limit: 30,
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
  // Bounds the error-level log past the global threshold to one entry per
  // window, so an attacker cannot fill the error log.
  magicLinkThresholdAlert: {
    scope: "magic_link:threshold_alert",
    limit: 1,
    windowSeconds: 5 * 60,
    minIntervalSeconds: 0,
  },
  // Redirects cannot show a challenge, so these match the magic link's cap.
  googleStartNetwork: {
    scope: "google_start:network",
    limit: 30,
    windowSeconds: 10 * 60,
    minIntervalSeconds: 0,
  },
  callbackNetwork: {
    scope: "callback:network",
    limit: 60,
    windowSeconds: 10 * 60,
    minIntervalSeconds: 0,
  },
  // GoTrue counts code exchanges, refreshes and password grants in one bucket
  // per client IP (`limiterOpts.Token`, 150 per 5 minutes by default), and
  // they all come from this application's servers. Per-network limits have
  // no total, so this and sessionRefreshGlobal (100) keep the sum under 150:
  // many networks cannot spend the bucket and have real refreshes refused.
  // One exchange per ticket: a copied ticket cannot be replayed into many
  // exchanges and so cannot spend the service-wide ceiling below.
  callbackTicket: {
    scope: "callback:ticket",
    limit: 1,
    windowSeconds: 60 * 60,
    minIntervalSeconds: 0,
  },
  callbackGlobal: {
    scope: "callback:global",
    limit: 40,
    windowSeconds: 5 * 60,
    minIntervalSeconds: 0,
  },
  callbackCeilingAlert: {
    scope: "callback:ceiling_alert",
    limit: 1,
    windowSeconds: 5 * 60,
    minIntervalSeconds: 0,
  },
  // Consumed by the proxy (TASK-003f).
  sessionRefreshNetwork: {
    scope: "session_refresh:network",
    limit: 30,
    windowSeconds: 5 * 60,
    minIntervalSeconds: 0,
  },
  // Service-wide, under GoTrue's own per-IP token bucket (150 per 5 minutes,
  // shared with callback exchanges: 40 there plus 100 here).
  sessionRefreshGlobal: {
    scope: "session_refresh:global",
    limit: 100,
    windowSeconds: 5 * 60,
    minIntervalSeconds: 0,
  },
  sessionRefreshCeilingAlert: {
    scope: "session_refresh:ceiling_alert",
    limit: 1,
    windowSeconds: 5 * 60,
    minIntervalSeconds: 0,
  },
  // The public disclosure endpoint (TASK-019a), the one surface with no
  // session at all. One page view is one request, but the 60-second shared
  // cache absorbs the repeats, so the origin sees roughly one request per
  // deployment per minute per region: a network that reaches this limit is
  // asking for far more than a browser does. Past it, 429.
  publicDisclosureNetwork: {
    scope: "public_disclosure:network",
    limit: 300,
    windowSeconds: 5 * 60,
    minIntervalSeconds: 0,
  },
  // Service-wide, and alert-only: past this the request is still served
  // (project owner, 2026-09-26). A ceiling that refused would take every
  // customer's notice off every customer's site at once, decided by
  // whoever is making the noise.
  publicDisclosureGlobal: {
    scope: "public_disclosure:global",
    limit: 20_000,
    windowSeconds: 5 * 60,
    minIntervalSeconds: 0,
  },
  // Bounds that alert to one entry per window, so the flood does not also
  // decide the log volume.
  publicDisclosureCeilingAlert: {
    scope: "public_disclosure:ceiling_alert",
    limit: 1,
    windowSeconds: 5 * 60,
    minIntervalSeconds: 0,
  },
} as const satisfies Record<string, RateLimit>;

export type RateLimitName = keyof typeof RATE_LIMITS;

/**
 * A limiter that hangs must not hold every sign-in open: past this, the call
 * is abandoned and the request refused as unavailable.
 */
export const RATE_LIMIT_TIMEOUT_MS = 2000;

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
    response = await createServiceRoleClient()
      .rpc("consume_rate_limit", {
        p_key: rateLimitKey(scope, value),
        p_limit: limit,
        p_window_seconds: windowSeconds,
        p_min_interval_seconds: minIntervalSeconds,
      })
      .abortSignal(AbortSignal.timeout(RATE_LIMIT_TIMEOUT_MS));
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
