import { serverEnv } from "@/lib/env/server-env";

/**
 * These suites create users, send mail and revoke sessions. They must only
 * ever reach the Supabase instance on this machine, so a non-local URL stops
 * the run before any test starts.
 */
const { hostname } = new URL(serverEnv().SUPABASE_URL);

if (hostname !== "127.0.0.1" && hostname !== "localhost") {
  throw new Error(
    `Refusing to run real-Supabase suites against ${hostname}: only a local instance is allowed.`,
  );
}
