import { afterEach, describe, expect, it, vi } from "vitest";

// The real marker throws outside a react-server bundle, which is the build-time
// guarantee; Vitest is not that bundle, so the marker is neutralised here only.
vi.mock("server-only", () => ({}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({})),
}));

// Distinct from tests/setup-test-env.ts, so a factory that bypassed lib/env and
// read process.env directly would be caught by the argument assertions.
vi.mock("@/lib/env/server-env", () => ({
  serverEnv: () => ({
    SUPABASE_URL: "http://env-module.supabase.test",
    SUPABASE_ANON_KEY: "env-module-anon-key",
    SUPABASE_SERVICE_ROLE_KEY: "env-module-service-role-key",
  }),
}));

import { createClient } from "@supabase/supabase-js";

import { createServiceRoleClient } from "@/lib/database/service-role-client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createServiceRoleClient", () => {
  it("throws when called in a browser runtime", () => {
    vi.stubGlobal("window", {});

    expect(() => createServiceRoleClient()).toThrow(/browser runtime/);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("reads the service-role key from lib/env rather than process.env", () => {
    createServiceRoleClient();

    expect(createClient).toHaveBeenCalledWith(
      "http://env-module.supabase.test",
      "env-module-service-role-key",
      expect.anything(),
    );
  });

  it("carries no user session, so it cannot act as a signed-in user", () => {
    createServiceRoleClient();

    expect(createClient).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      },
    );
  });
});
