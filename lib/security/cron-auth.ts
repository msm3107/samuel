import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

import { serverEnv } from "@/lib/env/server-env";

/**
 * Authenticating a scheduled call (TASK-025; PLAN Phase 7).
 *
 * The verification route is the one endpoint in this application that acts
 * with the service-role client on nobody's behalf: it reads across every
 * tenant and writes evidence customers rely on. Its only door is a shared
 * secret, so the comparison is worth doing properly.
 *
 * **Both sides are hashed first.** `timingSafeEqual` refuses buffers of
 * different lengths, so comparing the raw values would need a length check in
 * front of it — and a length check that runs before a constant-time comparison
 * tells an attacker how long the secret is. Hashing makes both operands
 * exactly 32 bytes whatever arrives, so neither the length nor the content of
 * `CRON_SECRET` is observable through timing. (`lib/auth/sign-in/flow-ticket.ts`
 * does compare lengths first; that is safe there because its input is a hex
 * signature whose length is fixed and published.)
 *
 * `CRON_SECRET` is `z.string().min(32)` in the environment module, so a short
 * secret is a configuration failure at boot rather than a weak door at
 * runtime.
 */

/** The header Vercel Cron sends. */
const SCHEME = "Bearer ";

function digest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Whether `request` carries this installation's cron secret.
 *
 * Only `Authorization: Bearer <secret>`. A query parameter is not accepted
 * even if one is present: a URL reaches access logs, browser history and
 * `Referer` headers, and a secret in a URL is a secret in somebody's log file
 * (§16).
 *
 * The scheme is compared as a plain prefix, case-insensitively: RFC 7235 makes
 * an authentication scheme case-insensitive, and refusing `bearer` would mean a
 * verifier that silently never runs. Only what follows the scheme is secret, so
 * there is nothing to protect in that comparison.
 */
export function hasCronSecret(request: Request): boolean {
  const header = request.headers.get("authorization");
  if (
    header === null ||
    header.slice(0, SCHEME.length).toLowerCase() !== SCHEME.toLowerCase()
  ) {
    return false;
  }
  return timingSafeEqual(
    digest(header.slice(SCHEME.length)),
    digest(serverEnv().CRON_SECRET),
  );
}
