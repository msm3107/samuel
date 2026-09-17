import { describe, expect, it, vi } from "vitest";

const cookieStore = vi.hoisted(() => ({
  getAll: vi.fn(() => [{ name: "sb-auth-token", value: "stored-session" }]),
  set: vi.fn(),
}));

const loggerWarn = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => cookieStore),
}));

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({})),
}));

vi.mock("@/lib/logging/logger", () => ({
  logger: { warn: loggerWarn },
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

import { createServerClient } from "@supabase/ssr";

import { createSessionClient } from "@/lib/database/session-client";

type CookieMethods = {
  getAll: () => unknown;
  setAll: (
    cookies: { name: string; value: string; options: object }[],
    headers: Record<string, string>,
  ) => void;
};

async function cookieMethodsPassedToSupabase(): Promise<CookieMethods> {
  await createSessionClient();

  const options = vi.mocked(createServerClient).mock.calls[0]?.[2];
  if (!options) {
    throw new Error("createServerClient was not called");
  }

  return options.cookies as CookieMethods;
}

describe("createSessionClient", () => {
  it("uses the anon key from lib/env and never the service-role key", async () => {
    await createSessionClient();

    const [url, key] = vi.mocked(createServerClient).mock.calls[0] ?? [];
    expect(url).toBe("http://env-module.supabase.test");
    expect(key).toBe("env-module-anon-key");
  });

  it("reads the session from the request cookies", async () => {
    const cookies = await cookieMethodsPassedToSupabase();

    expect(cookies.getAll()).toEqual([
      { name: "sb-auth-token", value: "stored-session" },
    ]);
  });

  it("writes refreshed session cookies where the context allows it", async () => {
    const cookies = await cookieMethodsPassedToSupabase();

    cookies.setAll(
      [{ name: "sb-auth-token", value: "refreshed", options: { path: "/" } }],
      {},
    );

    // Hardened before writing: the session cookie holds the access and refresh
    // tokens, and this application has no browser client that needs to read it.
    expect(cookieStore.set).toHaveBeenCalledWith("sb-auth-token", "refreshed", {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "lax",
    });
  });

  it("keeps a session cookie out of reach of injected script", async () => {
    const cookies = await cookieMethodsPassedToSupabase();

    cookies.setAll(
      [{ name: "sb-auth-token", value: "refreshed", options: {} }],
      {},
    );

    const [, , options] = cookieStore.set.mock.calls[0] ?? [];
    expect(options).toMatchObject({ httpOnly: true, secure: true, path: "/" });
  });

  it("logs rather than throws when a server component cannot write cookies", async () => {
    cookieStore.set.mockImplementationOnce(() => {
      throw new Error("Cookies can only be modified in a Server Action");
    });
    const cookies = await cookieMethodsPassedToSupabase();

    expect(() =>
      cookies.setAll(
        [{ name: "sb-auth-token", value: "refreshed-secret", options: {} }],
        {},
      ),
    ).not.toThrow();

    expect(loggerWarn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(loggerWarn.mock.calls[0])).not.toContain(
      "refreshed-secret",
    );
  });
});
