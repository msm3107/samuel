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
    ...options,
    httpOnly: true,
    secure: !isDevelopment,
    sameSite: options.sameSite ?? "lax",
    path: options.path ?? "/",
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
