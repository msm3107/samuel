import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { NextRequest, NextResponse } from "next/server";

import {
  hardenCookieOptions,
  PKCE_FLOW_OPTIONS,
} from "@/lib/database/session-cookie-options";
import { serverEnv } from "@/lib/env/server-env";

type PendingCookie = { name: string; value: string; options: CookieOptions };

/**
 * The session client for `proxy.ts`, where token refresh must happen before
 * anything renders.
 *
 * It deliberately never builds a `NextResponse` of its own. The proxy's
 * response already carries the CSP nonce on its request headers, and replacing
 * that response would drop either the nonce or the refreshed cookies. Instead:
 *
 * 1. Create the client and call `auth.getUser()` before copying
 *    `request.headers`, so the copy includes any refreshed cookie.
 * 2. Build the response as usual.
 * 3. Call `applySessionCookies(response)` before returning it.
 */
export function createProxySessionClient(request: NextRequest) {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = serverEnv();

  const pendingCookies: PendingCookie[] = [];
  const pendingHeaders = new Map<string, string>();

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: PKCE_FLOW_OPTIONS,
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet, headers) => {
        const removesOnly = cookiesToSet.every(({ value, options }) =>
          isRemoval(value, options),
        );
        for (const { name, value } of cookiesToSet) {
          // Server code rendering this request reads cookies from the request,
          // so it must see the refreshed token rather than the expired one.
          //
          // A batch that only removes the session is kept out of the request:
          // creating this client subscribes to auth events, which makes
          // auth-js refresh in the background and, on a failure, delete the
          // session. Writing that through would hide the session from this
          // request's own resolution, which then reads as "signed out" — a
          // 429 would sign the person out (TASK-003i). Whether the removal
          // reaches the browser is still decided by applySessionCookies.
          if (!removesOnly) {
            request.cookies.set(name, value);
          }
        }
        pendingCookies.push(...cookiesToSet);
        for (const [headerName, headerValue] of Object.entries(headers)) {
          pendingHeaders.set(headerName, headerValue);
        }
      },
    },
  });

  /**
   * With `keepExistingSession`, cookie removals are dropped. The proxy passes
   * it when the session could not be verified: auth-js deletes the session
   * after any non-retryable refresh failure, including a 429 caused by other
   * people's traffic, and forwarding that deletion would sign the person out
   * over something that says nothing about their session. Refreshed tokens
   * are still written — a rotated refresh token must reach the browser.
   */
  function applySessionCookies(
    response: NextResponse,
    { keepExistingSession = false }: { keepExistingSession?: boolean } = {},
  ) {
    for (const { name, value, options } of pendingCookies) {
      if (keepExistingSession && isRemoval(value, options)) {
        continue;
      }
      response.cookies.set(name, value, hardenCookieOptions(options));
    }
    // Supplied by @supabase/ssr whenever it sets auth cookies, so a CDN never
    // serves one user's session cookie to another.
    for (const [headerName, headerValue] of pendingHeaders) {
      response.headers.set(headerName, headerValue);
    }
  }

  return { supabase, applySessionCookies };
}

function isRemoval(value: string, options: CookieOptions) {
  return (
    value === "" ||
    options.maxAge === 0 ||
    (options.expires !== undefined &&
      new Date(options.expires).getTime() <= Date.now())
  );
}
