import { z } from "zod";

/**
 * How long a session lasts after its last real sign-in (TASK-003h), matching
 * `auth.sessions.timebox` in `supabase/config.toml`. Enforced here because
 * hosted Supabase applies its own time-box only on a paid plan.
 */
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

const claimsSchema = z.object({
  amr: z
    .array(
      z.object({
        method: z.string(),
        timestamp: z.number().int().nonnegative(),
      }),
    )
    .min(1),
});

/**
 * The time of the session's last real sign-in, in Unix seconds, from the
 * access token's `amr` claim. GoTrue lists each authentication method used in
 * the session with the time it was last used (`Session.CalculateAALAndAMR`),
 * and a token refresh adds no entry, so the newest timestamp is the last
 * sign-in. Returns null when the claim is missing or malformed.
 *
 * Decodes without verifying the signature. Callers must pass only a token the
 * auth server has just accepted.
 */
export function lastSignInAt(accessToken: string): number | null {
  const payload = accessToken.split(".")[1];
  if (!payload) {
    return null;
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  const claims = claimsSchema.safeParse(decoded);
  if (!claims.success) {
    return null;
  }
  return Math.max(...claims.data.amr.map((entry) => entry.timestamp));
}

/**
 * Whether a validated access token's session is past its absolute limit. A
 * token without a readable sign-in time counts as expired: failing closed
 * signs the person out rather than keeping a session with no end.
 */
export function isSessionExpired(
  accessToken: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  const signedInAt = lastSignInAt(accessToken);
  if (signedInAt === null) {
    return true;
  }
  // A timestamp ahead of this server's clock is treated as now.
  return (
    nowSeconds - Math.min(signedInAt, nowSeconds) > SESSION_MAX_AGE_SECONDS
  );
}
