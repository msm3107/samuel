import { z } from "zod";

import { InvalidEnvironmentError } from "./invalid-environment-error";

const clientEnvSchema = z.object({
  NEXT_PUBLIC_APP_URL: z.url(),
});

export type ClientEnv = Readonly<z.infer<typeof clientEnvSchema>>;

export function parseClientEnv(source: Record<string, unknown>): ClientEnv {
  const result = clientEnvSchema.safeParse(source);

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

let cachedClientEnv: ClientEnv | undefined;

/**
 * Configuration that is safe to ship to the browser.
 *
 * Next.js only inlines NEXT_PUBLIC_* variables that appear as literal property
 * reads, so each variable is named explicitly instead of spreading process.env.
 * Spreading would also risk sweeping a server secret into the client bundle.
 */
export function clientEnv(): ClientEnv {
  cachedClientEnv ??= parseClientEnv({
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  });

  return cachedClientEnv;
}
