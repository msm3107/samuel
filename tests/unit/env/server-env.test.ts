import { describe, expect, it } from "vitest";

import { InvalidEnvironmentError } from "@/lib/env/invalid-environment-error";
import { parseServerEnv } from "@/lib/env/server-env";

function validEnv(): Record<string, string> {
  return {
    NODE_ENV: "test",
    NEXT_PUBLIC_APP_URL: "https://app.example.com",
    SUPABASE_URL: "https://project.supabase.co",
    SUPABASE_ANON_KEY: "anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    STRIPE_SECRET_KEY: "sk_test_x",
    STRIPE_WEBHOOK_SECRET: "whsec_x",
    CRON_SECRET: "a".repeat(32),
  };
}

describe("parseServerEnv", () => {
  it("accepts a complete configuration", () => {
    const env = parseServerEnv(validEnv());

    expect(env.SUPABASE_URL).toBe("https://project.supabase.co");
    expect(env.NODE_ENV).toBe("test");
  });

  it("defaults the log level to info when it is not configured", () => {
    expect(parseServerEnv(validEnv()).LOG_LEVEL).toBe("info");
  });

  it("rejects a configuration missing a required secret", () => {
    const source = validEnv();
    delete source.SUPABASE_SERVICE_ROLE_KEY;

    expect(() => parseServerEnv(source)).toThrow(InvalidEnvironmentError);
  });

  it("rejects an empty required secret rather than treating it as configured", () => {
    expect(() =>
      parseServerEnv({ ...validEnv(), SUPABASE_ANON_KEY: "" }),
    ).toThrow(InvalidEnvironmentError);
  });

  it("rejects a cron secret shorter than 32 characters", () => {
    expect(() =>
      parseServerEnv({ ...validEnv(), CRON_SECRET: "short" }),
    ).toThrow(InvalidEnvironmentError);
  });

  it("rejects a malformed application URL", () => {
    expect(() =>
      parseServerEnv({ ...validEnv(), NEXT_PUBLIC_APP_URL: "app.example.com" }),
    ).toThrow(InvalidEnvironmentError);
  });

  it("treats optional Stripe price identifiers as absent when unset", () => {
    const env = parseServerEnv(validEnv());

    expect(env.STRIPE_PRICE_FOUNDER).toBeUndefined();
  });

  it("returns a frozen object so configuration cannot be mutated at runtime", () => {
    const env = parseServerEnv(validEnv());

    expect(Object.isFrozen(env)).toBe(true);
  });
});
