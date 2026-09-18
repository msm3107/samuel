import type { CookieOptions } from "@supabase/ssr";

import { isDevelopment } from "@/lib/env/runtime-mode";

/**
 * Hardens the attributes `@supabase/ssr` asks for before a session cookie is
 * written.
 *
 * The library leaves `httpOnly` unset so that a browser client can read the
 * session. This application has no browser client — every Supabase call is
 * server-side — so the cookie holding the access and refresh tokens is kept
 * out of JavaScript's reach, and script injected into a page cannot read or
 * exfiltrate a session.
 *
 * `secure` is omitted in development only, because `http://localhost` would
 * otherwise never receive the cookie.
 */
export function hardenCookieOptions(options: CookieOptions): CookieOptions {
  return {
    ...capLifetime(options),
    httpOnly: true,
    secure: !isDevelopment,
    sameSite: options.sameSite ?? "lax",
    path: options.path ?? "/",
  };
}

/**
 * The auth server ends a session 7 days after sign-in (`auth.sessions.timebox`
 * in `supabase/config.toml`, TASK-003e), so no cookie carrying one is kept
 * longer. `@supabase/ssr` asks for 400 days.
 */
export const SESSION_COOKIE_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/**
 * Caps a lifetime that runs past the limit. Removals (a maximum age of 0 or an
 * expiry in the past) and browser-session cookies (no lifetime at all) are
 * left as they are.
 */
function capLifetime(options: CookieOptions): CookieOptions {
  const { expires, maxAge } = options;
  const limitMs = SESSION_COOKIE_MAX_AGE_SECONDS * 1000;
  const expiresTooLate =
    expires !== undefined && new Date(expires).getTime() > Date.now() + limitMs;
  const maxAgeTooLong =
    maxAge !== undefined && maxAge > SESSION_COOKIE_MAX_AGE_SECONDS;

  if (!expiresTooLate && !maxAgeTooLong) {
    return options;
  }
  const { expires: _dropped, ...rest } = options;
  return {
    ...rest,
    maxAge: Math.min(maxAge ?? Infinity, SESSION_COOKIE_MAX_AGE_SECONDS),
  };
}

/**
 * Gives every PKCE flow its own verifier slot and carries the flow's id on the
 * redirect (`sb_flow_id`), so the callback exchanges the code with that flow's
 * verifier. Without it, all flows share one slot: requesting a second link, or
 * a request GoTrue rejects (auth-js then deletes the verifier), breaks a link
 * already sent — in one tab, with ordinary use. Codex review of PR #6, F1.
 */
export const PKCE_FLOW_OPTIONS = {
  experimental: { appendPkceFlowIdToRedirects: true },
} as const;
