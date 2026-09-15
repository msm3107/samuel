/**
 * NODE_ENV is a build-time constant that every runtime can read, unlike the
 * validated server configuration in server-env.ts, which holds secrets and is
 * unavailable to the edge runtime. Keeping the two separate lets middleware
 * vary behavior by mode without reaching for secrets it must not have.
 */
export const isDevelopment = process.env.NODE_ENV === "development";
