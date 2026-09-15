import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { NextRequest, NextResponse } from "next/server";

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
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet, headers) => {
        for (const { name, value } of cookiesToSet) {
          // Server code rendering this request reads cookies from the request,
          // so it must see the refreshed token rather than the expired one.
          request.cookies.set(name, value);
        }
        pendingCookies.push(...cookiesToSet);
        for (const [headerName, headerValue] of Object.entries(headers)) {
          pendingHeaders.set(headerName, headerValue);
        }
      },
    },
  });

  function applySessionCookies(response: NextResponse) {
    for (const { name, value, options } of pendingCookies) {
      response.cookies.set(name, value, options);
    }
    // Supplied by @supabase/ssr whenever it sets auth cookies, so a CDN never
    // serves one user's session cookie to another.
    for (const [headerName, headerValue] of pendingHeaders) {
      response.headers.set(headerName, headerValue);
    }
  }

  return { supabase, applySessionCookies };
}
