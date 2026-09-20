import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { cookies } from "next/headers";

import { hardenCookieOptions } from "@/lib/database/session-cookie-options";
import { serverEnv } from "@/lib/env/server-env";

/**
 * Proof that this application started a sign-in flow in this browser
 * (TASK-003g). The callback refuses anything without one before it spends a
 * rate limit or calls Supabase Auth, so a bare `GET /auth/callback?code=…`
 * flood — no cookie, no flow, no valid code — costs an attacker nothing and
 * gains them nothing. Without it, such a flood could spend the service-wide
 * callback ceiling and refuse everyone else's sign-in.
 *
 * It says only "a flow started here recently". It carries no identity, so it
 * is not a credential: the PKCE verifier cookie is still what binds a code to
 * this browser.
 */
export const FLOW_TICKET_COOKIE = "a50_sign_in_flow";

/** GoTrue's own magic links expire in an hour (`auth.email.otp_expiry`). */
const TICKET_MAX_AGE_SECONDS = 60 * 60;

const TICKET_PATTERN = /^(\d{1,12})\.([0-9a-f]{32})\.([0-9a-f]{64})$/;

function sign(issuedAt: number, nonce: string) {
  return createHmac("sha256", serverEnv().RATE_LIMIT_HMAC_SECRET)
    .update(`flow-ticket:v1:${issuedAt}:${nonce}`)
    .digest("hex");
}

/**
 * Issues a ticket for a flow this application just started. Called wherever a
 * flow begins — a magic link, or a Google redirect — and never on a path that
 * did not start one.
 */
export async function issueFlowTicket(): Promise<void> {
  const issuedAt = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(16).toString("hex");
  const store = await cookies();

  store.set(
    FLOW_TICKET_COOKIE,
    `${issuedAt}.${nonce}.${sign(issuedAt, nonce)}`,
    hardenCookieOptions({
      maxAge: TICKET_MAX_AGE_SECONDS,
      // The callback is a top-level navigation from an email or from Google,
      // which "lax" allows.
      sameSite: "lax",
      path: "/",
    }),
  );
}

/**
 * Reads the ticket, checks its signature and age, and returns its nonce. The
 * nonce identifies the flow for the per-ticket limit, so one ticket cannot be
 * replayed into many exchanges.
 */
export function readFlowTicket(
  value: unknown,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const parts = TICKET_PATTERN.exec(value);
  if (!parts) {
    return null;
  }
  const [, issuedAtText = "", nonce = "", signature = ""] = parts;
  const issuedAt = Number(issuedAtText);

  const expected = Buffer.from(sign(issuedAt, nonce), "hex");
  const given = Buffer.from(signature, "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return null;
  }
  // A ticket from the future is a clock problem, not a valid flow.
  if (issuedAt > nowSeconds || nowSeconds - issuedAt > TICKET_MAX_AGE_SECONDS) {
    return null;
  }
  return nonce;
}

/**
 * Takes the ticket out of the browser's cookies and returns its nonce, or null
 * if there is no valid one. Removing it keeps a finished flow from being
 * replayed by this browser; the per-ticket limit is what stops a copied value
 * being replayed by anyone else.
 */
export async function consumeFlowTicket(): Promise<string | null> {
  const store = await cookies();
  const nonce = readFlowTicket(store.get(FLOW_TICKET_COOKIE)?.value);
  if (nonce !== null) {
    store.set(FLOW_TICKET_COOKIE, "", hardenCookieOptions({ maxAge: 0 }));
  }
  return nonce;
}
