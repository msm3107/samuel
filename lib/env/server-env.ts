import { z } from "zod";

import { InvalidEnvironmentError } from "./invalid-environment-error";

const logLevels = ["trace", "debug", "info", "warn", "error", "fatal"] as const;

const serverEnvSchema = z.object({
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

  SENTRY_DSN: z.url().optional(),

  LOG_LEVEL: z.enum(logLevels).default("info"),
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
