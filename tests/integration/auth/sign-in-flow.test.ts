// Integration: magic-link request, then callback, then requireSession()
// resolves the user. Runs the real @supabase/ssr and supabase-js code, the
// real callback route, sign-in functions, requireSession() and proxy, but
// against the STUB auth server installed as `fetch` — not a real Supabase
// instance. It proves the pieces fit together; it does not prove GoTrue
// accepts what they send.
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installStubAuthServer,
  proxyRequest,
  sessionCookieName,
  USER_A,
  USER_B,
  type StubUser,
} from "@/tests/security/auth/support/stub-auth-server";

/**
 * A cookie jar that behaves like a route handler's or server action's
 * `next/headers` store: writes are applied, so the PKCE verifier stored when a
 * flow starts is there when the callback reads it, and the session the
 * callback stores is there for the next request.
 */
const jar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string, options?: { maxAge?: number }) => {
      if (value === "" || options?.maxAge === 0) {
        jar.delete(name);
      } else {
        jar.set(name, value);
      }
    },
  }),
}));

import { GET } from "@/app/(auth)/auth/callback/route";
import { AuthenticationError } from "@/lib/auth/errors";
import { requireSession } from "@/lib/auth/require-session";
import { signOutAction } from "@/lib/auth/sign-in/actions";
import { requestMagicLink } from "@/lib/auth/sign-in/request-magic-link";
import { signOut } from "@/lib/auth/sign-in/sign-out";
import { startGoogleSignIn } from "@/lib/auth/sign-in/start-google-sign-in";
import { logger } from "@/lib/logging/logger";
import proxy from "@/proxy";

const APP_URL = "http://localhost:3000";
const MAGIC_LINK_CODE_A = "3f2b8c1d-9a4e-4b7f-8c2d-1e6a5b9f0c33";
const MAGIC_LINK_CODE_B = "a1c4e7f0-2b5d-4e8a-9c1f-3d6b9e2a5c44";
const GOOGLE_CODE_A = "5e8b1d4a-7c0f-4a3d-8b6e-9f2c5a8d1b55";

afterEach(() => {
  vi.unstubAllGlobals();
  jar.clear();
});

function verifierCookieName() {
  return `${sessionCookieName()}-code-verifier`;
}

/** The session cookie and any chunks of it (`<name>.0`, `<name>.1`, …). */
function sessionCookieEntries() {
  const name = sessionCookieName();
  return [...jar].filter(
    ([cookieName]) =>
      cookieName === name || /^\d+$/.test(cookieName.slice(name.length + 1)),
  );
}

/** Reassembles and decodes the session `@supabase/ssr` stored in the jar. */
function storedSession(): unknown {
  const name = sessionCookieName();
  const whole = jar.get(name);
  const encoded =
    whole ??
    sessionCookieEntries()
      .sort(
        ([left], [right]) =>
          Number(left.slice(name.length + 1)) -
          Number(right.slice(name.length + 1)),
      )
      .map(([, value]) => value)
      .join("");
  if (!encoded) {
    return null;
  }
  const json = encoded.startsWith("base64-")
    ? Buffer.from(encoded.slice("base64-".length), "base64url").toString()
    : encoded;
  return JSON.parse(json);
}

function jarCookies() {
  return [...jar].map(([name, value]) => ({ name, value }));
}

function callbackRequest(query: string) {
  return new NextRequest(`${APP_URL}/auth/callback?${query}`);
}

/**
 * The callback URL a real link or provider redirect lands on: the redirect the
 * app asked for (which carries this flow's `sb_flow_id`) plus the code.
 */
function callbackFrom(redirectTo: string | null, code: string) {
  const url = new URL(redirectTo ?? "http://missing.invalid");
  expect(`${url.origin}${url.pathname}`).toBe(`${APP_URL}/auth/callback`);
  expect(url.searchParams.get("sb_flow_id")).toMatch(/^[0-9a-f]{32}$/);
  url.searchParams.set("code", code);
  return new NextRequest(url);
}

async function signInWithMagicLink(code: string) {
  await expect(requestMagicLink("  Person@Example.COM ")).resolves.toBe(
    "link_sent",
  );
  expect(jar.has(verifierCookieName())).toBe(true);

  const response = await GET(
    callbackRequest(`code=${encodeURIComponent(code)}`),
  );
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe(`${APP_URL}/dashboard`);
  return response;
}

function installFlowServer(pkceCodes: Record<string, StubUser>) {
  return installStubAuthServer({
    mode: "normal",
    users: [USER_A, USER_B],
    pkceCodes,
  });
}

function redirectTarget(error: unknown) {
  if (
    typeof error !== "object" ||
    error === null ||
    !("digest" in error) ||
    typeof error.digest !== "string"
  ) {
    throw new Error("Expected a Next.js redirect error with a digest");
  }
  const [marker, , target] = error.digest.split(";");
  return { marker, target };
}

describe("magic-link sign-in", () => {
  it("signs a person in through magic-link request, callback route, and requireSession()", async () => {
    const { requests } = installFlowServer({ [MAGIC_LINK_CODE_A]: USER_A });

    await expect(requestMagicLink("  Person@Example.COM ")).resolves.toBe(
      "link_sent",
    );
    const otpRequest = requests.find((request) =>
      request.path.startsWith("/auth/v1/otp"),
    );
    expect(otpRequest?.method).toBe("POST");
    const redirectTo = new URL(
      otpRequest?.path ?? "",
      "http://stub.invalid",
    ).searchParams.get("redirect_to");
    expect(sessionCookieEntries()).toEqual([]);

    const response = await GET(callbackFrom(redirectTo, MAGIC_LINK_CODE_A));

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${APP_URL}/dashboard`);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(requests).toContainEqual(
      expect.objectContaining({
        method: "POST",
        path: "/auth/v1/token?grant_type=pkce",
      }),
    );
    expect(sessionCookieEntries().length).toBeGreaterThan(0);
    expect(storedSession()).toMatchObject({
      access_token: USER_A.accessToken,
      refresh_token: USER_A.refreshToken,
    });

    await expect(requireSession()).resolves.toEqual({ userId: USER_A.id });
  });

  it("consumes the PKCE verifier cookie when the callback completes", async () => {
    installFlowServer({ [MAGIC_LINK_CODE_A]: USER_A });

    await signInWithMagicLink(MAGIC_LINK_CODE_A);

    expect(jar.has(verifierCookieName())).toBe(false);
  });

  it("lets the proxy through to /dashboard with the cookies the callback set", async () => {
    const { requests } = installFlowServer({ [MAGIC_LINK_CODE_A]: USER_A });
    await signInWithMagicLink(MAGIC_LINK_CODE_A);

    const response = await proxy(
      proxyRequest("/dashboard", { cookies: jarCookies() }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(requests).toContainEqual({
      method: "GET",
      path: "/auth/v1/user",
      authorization: `Bearer ${USER_A.accessToken}`,
    });
  });
});

describe("Google sign-in", () => {
  it("signs a person in through Google start, callback route, and requireSession()", async () => {
    const { requests } = installFlowServer({ [GOOGLE_CODE_A]: USER_A });

    const started = await startGoogleSignIn();

    expect(started.status).toBe("redirect");
    const providerUrl = new URL(
      started.status === "redirect" ? started.url : "http://missing.invalid",
    );
    expect(providerUrl.origin).toBe("http://127.0.0.1:54321");
    expect(providerUrl.pathname).toBe("/auth/v1/authorize");
    expect(providerUrl.searchParams.get("provider")).toBe("google");
    expect(providerUrl.searchParams.get("code_challenge")).toBeTruthy();
    // Starting OAuth is a browser navigation, not an auth-server call.
    expect(requests).toEqual([]);

    const response = await GET(
      callbackFrom(providerUrl.searchParams.get("redirect_to"), GOOGLE_CODE_A),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${APP_URL}/dashboard`);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(requireSession()).resolves.toEqual({ userId: USER_A.id });

    const proxied = await proxy(
      proxyRequest("/dashboard", { cookies: jarCookies() }),
    );
    expect(proxied.status).toBe(200);
    expect(proxied.headers.get("location")).toBeNull();
  });
});

describe("sign-out", () => {
  it("revokes the session locally on the auth server, clears the cookie, and locks the dashboard again", async () => {
    const { requests } = installFlowServer({ [MAGIC_LINK_CODE_A]: USER_A });
    await signInWithMagicLink(MAGIC_LINK_CODE_A);
    await expect(requireSession()).resolves.toEqual({ userId: USER_A.id });

    await signOut();

    const logoutRequests = requests.filter((request) =>
      request.path.startsWith("/auth/v1/logout"),
    );
    expect(logoutRequests).toEqual([
      {
        method: "POST",
        path: "/auth/v1/logout?scope=local",
        authorization: `Bearer ${USER_A.accessToken}`,
      },
    ]);
    expect(sessionCookieEntries()).toEqual([]);

    const failure = await requireSession().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AuthenticationError);
    expect(failure).toMatchObject({ code: "session_missing" });

    const response = await proxy(
      proxyRequest("/dashboard", { cookies: jarCookies() }),
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${APP_URL}/sign-in`);
  });

  it.each([
    {
      failure: "a 500 from the logout endpoint",
      fail: async () =>
        new Response(
          JSON.stringify({ code: "unexpected_failure", msg: "stubbed" }),
          {
            status: 500,
            headers: {
              "content-type": "application/json",
              "x-supabase-api-version": "2024-01-01",
            },
          },
        ),
    },
    {
      failure: "a network failure on the logout call",
      fail: async (): Promise<Response> => {
        throw new TypeError("fetch failed");
      },
    },
  ])(
    "still clears the session cookie and logs a token-free warning after $failure",
    async ({ fail }) => {
      installFlowServer({ [MAGIC_LINK_CODE_A]: USER_A });
      await signInWithMagicLink(MAGIC_LINK_CODE_A);
      await expect(requireSession()).resolves.toEqual({ userId: USER_A.id });

      // Fails only the revoke call, so the session still loads beforehand.
      const stubFetch = globalThis.fetch;
      const logoutCalls: string[] = [];
      vi.stubGlobal(
        "fetch",
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(new Request(input, init).url);
          if (url.pathname === "/auth/v1/logout") {
            logoutCalls.push(`${url.pathname}${url.search}`);
            return fail();
          }
          return stubFetch(input, init);
        },
      );
      const warn = vi.spyOn(logger, "warn");

      await expect(signOut()).resolves.toBeUndefined();

      expect(logoutCalls.length).toBeGreaterThan(0);
      expect(
        logoutCalls.every((path) => path === "/auth/v1/logout?scope=local"),
      ).toBe(true);
      expect(sessionCookieEntries()).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: "sign_out_revoke_failed" }),
      );

      const logged = JSON.stringify(warn.mock.calls);
      expect(logged).not.toContain(USER_A.accessToken);
      expect(logged).not.toContain(USER_A.refreshToken);
      expect(logged).not.toContain(sessionCookieName());
      expect(logged).not.toContain("@example");

      await expect(requireSession()).rejects.toBeInstanceOf(
        AuthenticationError,
      );
    },
  );

  it("signOutAction signs out and redirects to /sign-in", async () => {
    const { requests } = installFlowServer({ [MAGIC_LINK_CODE_A]: USER_A });
    await signInWithMagicLink(MAGIC_LINK_CODE_A);

    const thrown = await signOutAction().then(
      () => null,
      (error: unknown) => error,
    );

    expect(thrown).not.toBeNull();
    const { marker, target } = redirectTarget(thrown);
    expect(marker).toBe("NEXT_REDIRECT");
    expect(target).toBe("/sign-in");
    expect(
      requests.some(
        (request) =>
          request.method === "POST" &&
          request.path === "/auth/v1/logout?scope=local",
      ),
    ).toBe(true);
    expect(sessionCookieEntries()).toEqual([]);
  });
});

describe("sequential sign-ins in one browser", () => {
  it("replaces the first user's session with the second's so only the second resolves", async () => {
    const { requests } = installFlowServer({
      [MAGIC_LINK_CODE_A]: USER_A,
      [MAGIC_LINK_CODE_B]: USER_B,
    });

    await signInWithMagicLink(MAGIC_LINK_CODE_A);
    await expect(requireSession()).resolves.toEqual({ userId: USER_A.id });

    await signInWithMagicLink(MAGIC_LINK_CODE_B);

    expect(storedSession()).toMatchObject({
      access_token: USER_B.accessToken,
      refresh_token: USER_B.refreshToken,
    });
    const jarContents = JSON.stringify([...jar]);
    const decoded = JSON.stringify(storedSession());
    expect(jarContents).not.toContain(USER_A.accessToken);
    expect(decoded).not.toContain(USER_A.accessToken);
    expect(decoded).not.toContain(USER_A.refreshToken);
    expect(decoded).not.toContain(USER_A.id);

    const lookupsBefore = requests.length;
    await expect(requireSession()).resolves.toEqual({ userId: USER_B.id });
    const lookups = requests
      .slice(lookupsBefore)
      .filter((request) => request.path === "/auth/v1/user");
    expect(lookups).toEqual([
      {
        method: "GET",
        path: "/auth/v1/user",
        authorization: `Bearer ${USER_B.accessToken}`,
      },
    ]);
  });
});
