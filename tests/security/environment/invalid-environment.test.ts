import { describe, expect, it } from "vitest";

import { InvalidEnvironmentError } from "@/lib/env/invalid-environment-error";
import { parseServerEnv } from "@/lib/env/server-env";

const SERVICE_ROLE_KEY = "super-secret-service-role-key";

function envWithout(
  omitted: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const source: Record<string, string> = {
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_ROLE_KEY,
    STRIPE_SECRET_KEY: "sk_test_x",
    STRIPE_WEBHOOK_SECRET: "whsec_x",
    CRON_SECRET: "a".repeat(32),
    ...overrides,
  };

  delete source[omitted];

  return source;
}

describe("invalid environment configuration", () => {
  it.each([
    "SUPABASE_URL",
    "SUPABASE_ANON_KEY",
    "SUPABASE_SERVICE_ROLE_KEY",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "CRON_SECRET",
    "NEXT_PUBLIC_APP_URL",
  ])("fails startup when %s is missing", (variableName) => {
    expect(() => parseServerEnv(envWithout(variableName))).toThrow(
      InvalidEnvironmentError,
    );
  });

  it("names the offending variables without disclosing their values", () => {
    let thrown: unknown;

    try {
      parseServerEnv(envWithout("CRON_SECRET"));
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(InvalidEnvironmentError);

    const error = thrown as InvalidEnvironmentError;

    expect(error.variableNames).toContain("CRON_SECRET");
    expect(error.message).toContain("CRON_SECRET");
    expect(error.message).not.toContain(SERVICE_ROLE_KEY);
  });

  it("rejects a cron secret weak enough to guess", () => {
    expect(() =>
      parseServerEnv(envWithout("__none__", { CRON_SECRET: "a".repeat(31) })),
    ).toThrow(InvalidEnvironmentError);
  });
});
