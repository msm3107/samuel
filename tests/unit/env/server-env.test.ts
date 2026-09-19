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
    RATE_LIMIT_HMAC_SECRET: "b".repeat(32),
    TURNSTILE_SITE_KEY: "0x4AAAAAAAproductionSiteKey",
    TURNSTILE_SECRET_KEY: "0x4AAAAAAAproductionSecretKey",
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

  describe("in production", () => {
    function production(overrides: Record<string, string>) {
      return {
        ...validEnv(),
        NODE_ENV: "production",
        VERCEL: "1",
        ...overrides,
      };
    }

    it("requires VERCEL=1 off loopback, or every visitor shares one rate-limit bucket", () => {
      const source: Record<string, string> = production({});
      delete source.VERCEL;
      expect(() => parseServerEnv(source)).toThrow(InvalidEnvironmentError);
      expect(() => parseServerEnv(production({ VERCEL: "0" }))).toThrow(
        InvalidEnvironmentError,
      );
    });

    it("does not require VERCEL on loopback, where the local suites run", () => {
      const source: Record<string, string> = production({
        NEXT_PUBLIC_APP_URL: "http://localhost:3210",
      });
      delete source.VERCEL;
      expect(() => parseServerEnv(source)).not.toThrow();
    });

    it.each(["SUPABASE_URL", "NEXT_PUBLIC_APP_URL"])(
      "rejects a plain-http %s, which would carry keys and tokens in the clear",
      (name) => {
        expect(() =>
          parseServerEnv(production({ [name]: "http://app.example.com" })),
        ).toThrow(InvalidEnvironmentError);
      },
    );

    it("accepts https URLs", () => {
      expect(() => parseServerEnv(production({}))).not.toThrow();
    });

    it.each(["http://localhost:3210", "http://127.0.0.1:54321"])(
      "accepts loopback %s, which local production builds use",
      (url) => {
        expect(() =>
          parseServerEnv(
            production({ SUPABASE_URL: url, NEXT_PUBLIC_APP_URL: url }),
          ),
        ).not.toThrow();
      },
    );

    it.each([
      ["TURNSTILE_SITE_KEY", "1x00000000000000000000AA"],
      ["TURNSTILE_SITE_KEY", "3x00000000000000000000FF"],
      ["TURNSTILE_SECRET_KEY", "1x0000000000000000000000000000000AA"],
    ])(
      "rejects the Turnstile test key %s=%s, which passes every challenge",
      (name, value) => {
        expect(() => parseServerEnv(production({ [name]: value }))).toThrow(
          InvalidEnvironmentError,
        );
      },
    );

    it("accepts Turnstile test keys on a loopback application URL", () => {
      expect(() =>
        parseServerEnv(
          production({
            NEXT_PUBLIC_APP_URL: "http://localhost:3210",
            TURNSTILE_SITE_KEY: "1x00000000000000000000AA",
            TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
          }),
        ),
      ).not.toThrow();
    });

    it("rejects a look-alike host that is not loopback", () => {
      expect(() =>
        parseServerEnv(
          production({ SUPABASE_URL: "http://localhost.evil.example" }),
        ),
      ).toThrow(InvalidEnvironmentError);
    });
  });

  it("rejects a rate-limit HMAC secret shorter than 32 characters", () => {
    expect(() =>
      parseServerEnv({ ...validEnv(), RATE_LIMIT_HMAC_SECRET: "c".repeat(31) }),
    ).toThrow(InvalidEnvironmentError);
  });

  it.each([
    "RATE_LIMIT_HMAC_SECRET",
    "TURNSTILE_SITE_KEY",
    "TURNSTILE_SECRET_KEY",
  ])("requires %s", (name) => {
    const source = validEnv();
    delete source[name];
    expect(() => parseServerEnv(source)).toThrow(InvalidEnvironmentError);
  });

  it("allows plain http outside production, for local development", () => {
    expect(() =>
      parseServerEnv({
        ...validEnv(),
        SUPABASE_URL: "http://127.0.0.1:54321",
        NEXT_PUBLIC_APP_URL: "http://app.example.com",
      }),
    ).not.toThrow();
  });

  it("returns a frozen object so configuration cannot be mutated at runtime", () => {
    const env = parseServerEnv(validEnv());

    expect(Object.isFrozen(env)).toBe(true);
  });
});
