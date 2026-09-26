import "server-only";

import { createClient } from "@supabase/supabase-js";

import { serverEnv } from "@/lib/env/server-env";

/**
 * The anon key with no session at all: the client the public disclosure
 * endpoint uses (TASK-019a).
 *
 * Not the session client, which reads the request's cookies — the public
 * response is shared by a cache, and a response that depended on the
 * visitor would be served to the wrong one. Not the service-role client,
 * which must never serve a request another client can serve, least of all
 * the one request the whole internet can make.
 *
 * Its whole reach in this schema is `public.public_disclosure` (TASK-019):
 * no table, and no other function. The `server-only` import and the runtime
 * check below keep the anon key out of the browser bundle, which is what
 * makes the Next.js route — with its rate limit and its cache — the only way
 * to reach that function.
 */
export function createPublicClient() {
  if (typeof window !== "undefined") {
    throw new Error(
      "createPublicClient() was called in a browser runtime. The public endpoint is the only way to the public lookup.",
    );
  }

  const { SUPABASE_URL, SUPABASE_ANON_KEY } = serverEnv();

  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    // No user context, ever: nothing to persist, refresh, or pick up from a
    // URL, so this client cannot end up acting as somebody.
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}
