/**
 * Next.js runs this once per server start, which makes it the earliest place a
 * misconfigured deployment can be made to fail loudly (rule 15).
 */
export async function register() {
  // NEXT_RUNTIME is framework plumbing rather than application configuration;
  // the edge runtime has no access to server secrets and must not validate them.
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { serverEnv } = await import("@/lib/env/server-env");

  serverEnv();
}
