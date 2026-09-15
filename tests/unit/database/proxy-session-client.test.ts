import { NextRequest, NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@supabase/ssr", () => ({
  createServerClient: vi.fn(() => ({})),
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

import { createProxySessionClient } from "@/lib/database/proxy-session-client";

type CookieMethods = {
  getAll: () => { name: string; value: string }[];
  setAll: (
    cookies: { name: string; value: string; options: object }[],
    headers: Record<string, string>,
  ) => void;
};

function requestWithSessionCookie() {
  return new NextRequest("http://localhost:3000/dashboard", {
    headers: { cookie: "sb-auth-token=stored-session" },
  });
}

function cookieMethodsPassedToSupabase(): CookieMethods {
  const options = vi.mocked(createServerClient).mock.calls[0]?.[2];
  if (!options) {
    throw new Error("createServerClient was not called");
  }

  return options.cookies as CookieMethods;
}

function simulateTokenRefresh() {
  cookieMethodsPassedToSupabase().setAll(
    [
      {
        name: "sb-auth-token",
        value: "refreshed-session",
        options: { path: "/", httpOnly: true, sameSite: "lax" },
      },
    ],
    {
      "Cache-Control":
        "private, no-cache, no-store, must-revalidate, max-age=0",
    },
  );
}

describe("createProxySessionClient", () => {
  it("uses the anon key from lib/env and never the service-role key", () => {
    createProxySessionClient(requestWithSessionCookie());

    const [url, key] = vi.mocked(createServerClient).mock.calls[0] ?? [];
    expect(url).toBe("http://env-module.supabase.test");
    expect(key).toBe("env-module-anon-key");
  });

  it("reads the session from the incoming request cookies", () => {
    createProxySessionClient(requestWithSessionCookie());

    expect(cookieMethodsPassedToSupabase().getAll()).toEqual([
      { name: "sb-auth-token", value: "stored-session" },
    ]);
  });

  it("exposes refreshed cookies to server code rendering the same request", () => {
    const request = requestWithSessionCookie();
    createProxySessionClient(request);

    simulateTokenRefresh();

    expect(request.cookies.get("sb-auth-token")?.value).toBe(
      "refreshed-session",
    );
    expect(request.headers.get("cookie")).toContain(
      "sb-auth-token=refreshed-session",
    );
  });

  it("applies refreshed cookies without replacing the proxy's security headers", () => {
    const { applySessionCookies } = createProxySessionClient(
      requestWithSessionCookie(),
    );
    simulateTokenRefresh();

    const response = NextResponse.next();
    response.headers.set("Content-Security-Policy", "script-src 'nonce-abc'");
    applySessionCookies(response);

    expect(response.headers.get("Content-Security-Policy")).toBe(
      "script-src 'nonce-abc'",
    );
    expect(response.cookies.get("sb-auth-token")?.value).toBe(
      "refreshed-session",
    );
  });

  it("marks a response carrying refreshed cookies as uncacheable", () => {
    const { applySessionCookies } = createProxySessionClient(
      requestWithSessionCookie(),
    );
    simulateTokenRefresh();

    const response = NextResponse.next();
    applySessionCookies(response);

    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  it("leaves the response untouched when no refresh happened", () => {
    const { applySessionCookies } = createProxySessionClient(
      requestWithSessionCookie(),
    );

    const response = NextResponse.next();
    applySessionCookies(response);

    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("Cache-Control")).toBeNull();
  });
});
