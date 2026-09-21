import { z } from "zod";

import { InvalidEnvironmentError } from "./invalid-environment-error";

const logLevels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

/**
 * Cloudflare's published Turnstile test keys
 * (developers.cloudflare.com/turnstile/troubleshooting/testing/).
 */
export const TURNSTILE_TEST_SITE_KEYS: ReadonlySet<string> = new Set([
  "1x00000000000000000000AA",
  "2x00000000000000000000AB",
  "1x00000000000000000000BB",
  "2x00000000000000000000BB",
  "3x00000000000000000000FF",
]);

export const TURNSTILE_TEST_SECRET_KEYS: ReadonlySet<string> = new Set([
  "1x0000000000000000000000000000000AA",
  "2x0000000000000000000000000000000AA",
  "3x0000000000000000000000000000000AA",
]);

const serverEnvSchema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),

    NEXT_PUBLIC_APP_URL: z.url(),

    SUPABASE_URL: z.url(),
    SUPABASE_ANON_KEY: z.string().min(1),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

    STRIPE_SECRET_KEY: z.string().min(1),
    STRIPE_WEBHOOK_SECRET: z.string().min(1),

    // Price identifiers are only required once a plan is purchasable, so they
    // stay optional until billing ships.
    STRIPE_PRICE_FOUNDER: z.string().min(1).optional(),
    STRIPE_PRICE_AGENCY: z.string().min(1).optional(),
    STRIPE_PRICE_AGENCY_PRO: z.string().min(1).optional(),

    // Authenticates scheduled verification calls. Short values are guessable, so
    // the length floor is enforced as configuration rather than convention.
    CRON_SECRET: z.string().min(32),

    // Keys the sign-in rate-limit buckets (lib/security/rate-limit.ts), so the
    // database holds digests, never an email or IP address.
    RATE_LIMIT_HMAC_SECRET: z.string().min(32),

    // Cloudflare Turnstile, shown on the sign-in form only past the global
    // magic-link threshold. The site key is public; the secret is not.
    TURNSTILE_SITE_KEY: z.string().min(1),
    TURNSTILE_SECRET_KEY: z.string().min(1),

    // Set to "1" by Vercel. Client IPs are trusted from platform headers only
    // when it is (lib/security/client-ip.ts).
    VERCEL: z.string().optional(),

    SENTRY_DSN: z.url().optional(),

    LOG_LEVEL: z.enum(logLevels).default("info"),
  })
  .superRefine((env, context) => {
    // In production, keys and session tokens travel to these URLs, so plain
    // http would send them in the clear. Loopback stays allowed: production
    // builds are run locally by the end-to-end suites.
    if (env.NODE_ENV !== "production") {
      return;
    }
    for (const name of ["SUPABASE_URL", "NEXT_PUBLIC_APP_URL"] as const) {
      const url = new URL(env[name]);
      if (url.protocol !== "https:" && !LOOPBACK_HOSTS.has(url.hostname)) {
        context.addIssue({
          code: "custom",
          path: [name],
          message: "must use https in production",
        });
      }
    }
    // Cloudflare's published test keys pass every challenge. The local
    // production-build suites use them, on loopback only.
    if (!LOOPBACK_HOSTS.has(new URL(env.NEXT_PUBLIC_APP_URL).hostname)) {
      // Client networks are read from Vercel's header only on Vercel; anywhere
      // else every visitor would share one rate-limit bucket (TASK-003g).
      if (env.VERCEL !== "1") {
        context.addIssue({
          code: "custom",
          path: ["VERCEL"],
          message: "must be 1 in production: deploy on Vercel",
        });
      }
      if (TURNSTILE_TEST_SITE_KEYS.has(env.TURNSTILE_SITE_KEY)) {
        context.addIssue({
          code: "custom",
          path: ["TURNSTILE_SITE_KEY"],
          message: "must not be a Turnstile test key in production",
        });
      }
      if (TURNSTILE_TEST_SECRET_KEYS.has(env.TURNSTILE_SECRET_KEY)) {
        context.addIssue({
          code: "custom",
          path: ["TURNSTILE_SECRET_KEY"],
          message: "must not be a Turnstile test key in production",
        });
      }
    }
  });

export type ServerEnv = Readonly<z.infer<typeof serverEnvSchema>>;

/**
 * Validates a configuration source without touching module state, so tests can
 * exercise rejection paths without mutating the process environment.
 */
export function parseServerEnv(source: Record<string, unknown>): ServerEnv {
  const result = serverEnvSchema.safeParse(source);

  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    const variableNames = result.error.issues.map((issue) =>
      issue.path.join("."),
    );

    throw new InvalidEnvironmentError(problems, variableNames);
  }

  return Object.freeze(result.data);
}

let cachedServerEnv: ServerEnv | undefined;

/**
 * The single validated read of server configuration. Throws on first access if
 * configuration is invalid, which is what makes misconfiguration a startup
 * failure rather than a request-time surprise.
 */
export function serverEnv(): ServerEnv {
  if (typeof window !== "undefined") {
    throw new Error(
      "serverEnv() was called in a browser runtime. Server configuration must never reach the client bundle.",
    );
  }

  cachedServerEnv ??= parseServerEnv(process.env);

  return cachedServerEnv;
}
