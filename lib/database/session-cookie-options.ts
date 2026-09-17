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
