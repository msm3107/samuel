import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import proxy from "@/proxy";
import { LOCAL_NETWORK } from "@/lib/security/client-ip";
import {
  GLOBAL,
  RATE_LIMITS,
  rateLimitKey,
  type RateLimitName,
} from "@/lib/security/rate-limit";
import {
  installStubAuthServer,
  proxyRequest,
  sessionCookie,
  sessionCookieName,
  USER_A,
  type RecordedRateLimitCall,
} from "@/tests/security/auth/support/stub-auth-server";

/**
 * Every expired session makes the proxy refresh it from this application's own
 * address, and GoTrue counts refreshes per client IP, so anonymous junk
 * cookies could exhaust that budget and have everyone else refused (review
 * finding F2, TASK-003f).
 */

const REFRESHED_USER_A = {
  ...USER_A,
  accessToken: USER_A.accessToken,
  refreshToken: "refreshed-refresh",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

function key(name: RateLimitName, value: string) {
  return rateLimitKey(RATE_LIMITS[name].scope, value);
}

function refusing(...keys: string[]) {
  return (call: RecordedRateLimitCall) => !keys.includes(call.key);
}

const expiredCookie = () => sessionCookie(USER_A, { expiresInSeconds: -60 });

function tokenRequests(requests: { path: string }[]) {
  return requests.filter((request) => request.path.startsWith("/auth/v1/"));
}

function clearingSessionCookies(response: Response) {
  return response.headers
    .getSetCookie()
    .filter(
      (header) =>
        header.startsWith(`${sessionCookieName()}=;`) ||
        /Max-Age=0/i.test(header),
    );
}

describe("security: refreshes are limited before they reach the auth server", () => {
  it.each([
    [
      "the client network's limit",
      () => key("sessionRefreshNetwork", LOCAL_NETWORK),
    ],
    ["the service-wide ceiling", () => key("sessionRefreshGlobal", GLOBAL)],
  ])("makes no auth-server call past %s", async (_label, limitKey) => {
    const { requests } = installStubAuthServer(
      { mode: "normal", users: [USER_A], refreshedUsers: [REFRESHED_USER_A] },
      { rateLimit: refusing(limitKey()) },
    );

    const response = await proxy(
      proxyRequest("/dashboard", { cookies: [expiredCookie()] }),
    );

    expect(tokenRequests(requests)).toEqual([]);
    // Unverifiable, not signed out: nothing about the session is known.
    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
    expect(clearingSessionCookies(response)).toEqual([]);
  });

  it("deletes no cookie on a non-dashboard path either", async () => {
    const { requests } = installStubAuthServer(
      { mode: "normal", users: [USER_A] },
      { rateLimit: refusing(key("sessionRefreshNetwork", LOCAL_NETWORK)) },
    );

    const response = await proxy(
      proxyRequest("/", { cookies: [expiredCookie()] }),
    );

    expect(tokenRequests(requests)).toEqual([]);
    expect(clearingSessionCookies(response)).toEqual([]);
  });

  it("hides the session from handlers when it refuses, so they cannot refresh either", async () => {
    // A server action or route handler builds its own session client, and
    // creating one lets auth-js refresh in the background. The refusal has to
    // reach them, or the limit would only move the refresh downstream.
    const { requests } = installStubAuthServer(
      { mode: "normal", users: [USER_A], refreshedUsers: [REFRESHED_USER_A] },
      { rateLimit: refusing(key("sessionRefreshNetwork", LOCAL_NETWORK)) },
    );
    const session = expiredCookie();

    const response = await proxy(
      proxyRequest("/sign-in", {
        cookies: [
          session,
          { name: "a50_sign_in_flow", value: "ticket-value" },
          { name: `${sessionCookieName()}-code-verifier`, value: "verifier" },
        ],
      }),
    );

    const forwarded = response.headers.get("x-middleware-request-cookie") ?? "";
    expect(forwarded).not.toContain(session.value);
    expect(forwarded).not.toContain(`${sessionCookieName()}=`);
    // Only the session is hidden: a sign-in in progress keeps its cookies.
    expect(forwarded).toContain("a50_sign_in_flow=ticket-value");
    expect(forwarded).toContain(`${sessionCookieName()}-code-verifier=`);
    // And the browser still holds everything.
    expect(clearingSessionCookies(response)).toEqual([]);
    expect(tokenRequests(requests)).toEqual([]);
  });

  it("forwards the session untouched when it allows the refresh", async () => {
    installStubAuthServer({
      mode: "normal",
      users: [USER_A],
      refreshedUsers: [REFRESHED_USER_A],
    });

    const response = await proxy(
      proxyRequest("/sign-in", { cookies: [sessionCookie(USER_A)] }),
    );

    expect(response.headers.get("x-middleware-request-cookie")).toContain(
      `${sessionCookieName()}=`,
    );
  });

  it("spends nothing on a session cookie it cannot read", async () => {
    // auth-js treats an undecodable cookie as no session and asks the auth
    // server for nothing, so it must not cost anyone their allowance.
    const { rateLimitCalls, requests } = installStubAuthServer({
      mode: "normal",
      users: [USER_A],
    });

    for (const value of ["not-a-session", "base64-!!!", ""]) {
      await proxy(
        proxyRequest("/dashboard", {
          cookies: [{ name: sessionCookieName(), value }],
        }),
      );
    }

    expect(rateLimitCalls).toEqual([]);
    expect(
      requests.filter((request) => request.path.includes("grant_type")),
    ).toEqual([]);
  });

  it("spends nothing for a session whose access token is still valid", async () => {
    const { rateLimitCalls, requests } = installStubAuthServer({
      mode: "normal",
      users: [USER_A],
    });

    const response = await proxy(
      proxyRequest("/dashboard", { cookies: [sessionCookie(USER_A)] }),
    );

    expect(rateLimitCalls).toEqual([]);
    expect(response.status).toBe(200);
    // The session was still verified with the auth server, as before.
    expect(tokenRequests(requests)).not.toEqual([]);
  });

  it("spends nothing when there is no session at all", async () => {
    const { rateLimitCalls } = installStubAuthServer({
      mode: "normal",
      users: [USER_A],
    });

    await proxy(proxyRequest("/dashboard"));

    expect(rateLimitCalls).toEqual([]);
  });

  it("refreshes normally while under both limits", async () => {
    const { requests, rateLimitCalls } = installStubAuthServer({
      mode: "normal",
      users: [USER_A],
      refreshedUsers: [REFRESHED_USER_A],
    });

    const response = await proxy(
      proxyRequest("/dashboard", { cookies: [expiredCookie()] }),
    );

    expect(rateLimitCalls.map((call) => call.key)).toEqual([
      key("sessionRefreshNetwork", LOCAL_NETWORK),
      key("sessionRefreshGlobal", GLOBAL),
    ]);
    expect(
      requests.some((request) =>
        request.path.includes("grant_type=refresh_token"),
      ),
    ).toBe(true);
    expect(response.status).toBe(200);
  });

  it("is unverifiable, not signed out, when the limiter cannot answer", async () => {
    const { requests } = installStubAuthServer(
      { mode: "normal", users: [USER_A] },
      { rateLimit: "unavailable" },
    );

    const response = await proxy(
      proxyRequest("/dashboard", { cookies: [expiredCookie()] }),
    );

    expect(response.status).toBe(503);
    expect(tokenRequests(requests)).toEqual([]);
    expect(clearingSessionCookies(response)).toEqual([]);
  });
});
