import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

import {
  hardenCookieOptions,
  PKCE_FLOW_OPTIONS,
} from "@/lib/database/session-cookie-options";
import { serverEnv } from "@/lib/env/server-env";
import { logger } from "@/lib/logging/logger";

/**
 * The signed-in user's client for server components, route handlers, and
 * server actions. Row-level security applies. Create one per request; a client
 * shared across requests would carry one user's session into another's.
 *
 * Holds the anon key only, so it confers no privilege beyond the session in
 * the request's cookies.
 */
export async function createSessionClient() {
  const cookieStore = await cookies();
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = serverEnv();

  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: PKCE_FLOW_OPTIONS,
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, hardenCookieOptions(options));
          }
        } catch (error) {
          // Server components cannot write cookies. The proxy refreshes the
          // session before rendering, so a refresh here is a race rather than
          // a lost login — but it is logged, because a steady stream of these
          // means the proxy is not refreshing. Names only: values are tokens.
          logger.warn(
            {
              event: "session_cookie_write_skipped",
              errorName: error instanceof Error ? error.name : "unknown",
              cookieNames: cookiesToSet.map(({ name }) => name),
            },
            "Session cookies could not be written in this rendering context",
          );
        }
      },
    },
  });
}
