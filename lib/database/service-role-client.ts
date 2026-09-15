import "server-only";

import { createClient } from "@supabase/supabase-js";

import { serverEnv } from "@/lib/env/server-env";

/**
 * Bypasses row-level security. Reserved for work no signed-in user can perform
 * on their own behalf — scheduled verification, webhook processing — and never
 * used to serve a request the session client could serve.
 *
 * The `server-only` import makes a client-component import a build failure;
 * the runtime check below covers anything that slips past the bundler.
 */
export function createServiceRoleClient() {
  if (typeof window !== "undefined") {
    throw new Error(
      "createServiceRoleClient() was called in a browser runtime. The service-role key must never reach the client bundle.",
    );
  }

  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = serverEnv();

  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    // No user context: the client must never pick up, persist, or refresh a
    // session, or it would silently act with a user's identity instead.
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
