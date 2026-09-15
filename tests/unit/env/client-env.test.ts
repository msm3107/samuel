import { describe, expect, it } from "vitest";

import { InvalidEnvironmentError } from "@/lib/env/invalid-environment-error";
import { parseClientEnv } from "@/lib/env/client-env";

describe("parseClientEnv", () => {
  it("accepts a valid public application URL", () => {
    const env = parseClientEnv({
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
    });

    expect(env.NEXT_PUBLIC_APP_URL).toBe("https://app.example.com");
  });

  it("rejects a missing public application URL", () => {
    expect(() => parseClientEnv({})).toThrow(InvalidEnvironmentError);
  });

  it("ignores server variables supplied alongside public configuration", () => {
    const env = parseClientEnv({
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
    });

    expect(Object.keys(env)).toEqual(["NEXT_PUBLIC_APP_URL"]);
  });
});
