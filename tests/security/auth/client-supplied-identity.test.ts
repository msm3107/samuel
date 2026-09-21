import { afterEach, describe, expect, it, vi } from "vitest";

// The proxy now reaches the rate limiter, a server-only module.
vi.mock("server-only", () => ({}));

import type { headersCookieStore as HeadersCookieStore } from "./support/stub-auth-server";

type CookieStore = ReturnType<typeof HeadersCookieStore>;

// Typed as the harness store rather than Next's ReadonlyRequestCookies, so no
// cast is needed to hand the harness store to the session client.
const cookiesMock = vi.hoisted(() => vi.fn<() => Promise<CookieStore>>());

vi.mock("next/headers", () => ({ cookies: cookiesMock }));

import { AuthenticationError } from "@/lib/auth/errors";
import {
  requireDashboardSession,
  requireSession,
} from "@/lib/auth/require-session";
import proxy from "@/proxy";

import {
  headersCookieStore,
  installStubAuthServer,
  proxyRequest,
  sessionCookie,
  USER_A,
  USER_B,
} from "./support/stub-auth-server";

const SIGN_IN_URL = "http://localhost:3000/sign-in";

function useCookies(cookies: { name: string; value: string }[]) {
  cookiesMock.mockResolvedValue(headersCookieStore(cookies));
}

async function captureRejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("security: a client-supplied userId does not change the resolved identity", () => {
  it("accepts no argument that could carry a caller-supplied identity", () => {
    expect(requireSession.length).toBe(0);
    expect(requireDashboardSession.length).toBe(0);
  });

  it("resolves the session cookie's user even when the auth server also knows another user", async () => {
    const { requests } = installStubAuthServer({
      mode: "normal",
      users: [USER_A, USER_B],
    });
    useCookies([sessionCookie(USER_A)]);

    const session = await requireSession();

    expect(session).toEqual({ userId: USER_A.id });
    const userLookups = requests.filter(
      (request) => request.path === "/auth/v1/user",
    );
    expect(userLookups).toEqual([
      {
        method: "GET",
        path: "/auth/v1/user",
        authorization: `Bearer ${USER_A.accessToken}`,
      },
    ]);
  });

  it("resolves the session cookie's user through requireDashboardSession", async () => {
    installStubAuthServer({ mode: "normal", users: [USER_A, USER_B] });
    useCookies([sessionCookie(USER_A)]);

    await expect(requireDashboardSession()).resolves.toEqual({
      userId: USER_A.id,
    });
  });

  it("returns a frozen session object", async () => {
    installStubAuthServer({ mode: "normal", users: [USER_A] });
    useCookies([sessionCookie(USER_A)]);

    const session = await requireSession();

    expect(Object.isFrozen(session)).toBe(true);
  });

  it("authenticates a proxy request as the cookie's user despite query, header, and body inputs naming another user", async () => {
    const { requests } = installStubAuthServer({
      mode: "normal",
      users: [USER_A, USER_B],
    });

    const response = await proxy(
      proxyRequest(`/dashboard?userId=${USER_B.id}`, {
        method: "POST",
        cookies: [sessionCookie(USER_A)],
        headers: {
          "content-type": "application/json",
          "x-user-id": USER_B.id,
          "x-supabase-user": USER_B.id,
          authorization: `Bearer ${USER_B.accessToken}`,
        },
        body: JSON.stringify({ userId: USER_B.id }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request.authorization).toBe(`Bearer ${USER_A.accessToken}`);
    }
    expect(requests).toContainEqual({
      method: "GET",
      path: "/auth/v1/user",
      authorization: `Bearer ${USER_A.accessToken}`,
    });
  });

  it("redirects a dashboard request with no session cookie even when query, headers, and bearer token name a valid user", async () => {
    const { requests } = installStubAuthServer({
      mode: "normal",
      users: [USER_A],
    });

    const response = await proxy(
      proxyRequest(`/dashboard?userId=${USER_A.id}`, {
        headers: {
          "x-user-id": USER_A.id,
          "x-supabase-user": USER_A.id,
          authorization: `Bearer ${USER_A.accessToken}`,
        },
      }),
    );

    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    expect(response.headers.get("location")).toBe(SIGN_IN_URL);
    expect(
      requests.some(
        (request) => request.authorization === `Bearer ${USER_A.accessToken}`,
      ),
    ).toBe(false);
  });

  it("throws AuthenticationError from requireSession when the cookie store holds no session", async () => {
    const { requests } = installStubAuthServer({
      mode: "normal",
      users: [USER_A],
    });
    useCookies([]);

    const error = await captureRejection(requireSession());

    expect(error).toBeInstanceOf(AuthenticationError);
    expect(requests).toEqual([]);
  });

  it("resolves the user the auth server validates for the token, not the user claimed inside the cookie", async () => {
    const { requests } = installStubAuthServer({
      mode: "normal",
      users: [USER_A, USER_B],
    });
    const forged = sessionCookie({
      id: USER_B.id,
      accessToken: USER_A.accessToken,
      refreshToken: USER_A.refreshToken,
    });
    useCookies([forged]);

    const session = await requireSession();

    expect(session).toEqual({ userId: USER_A.id });
    expect(session.userId).not.toBe(USER_B.id);
    expect(requests).toContainEqual({
      method: "GET",
      path: "/auth/v1/user",
      authorization: `Bearer ${USER_A.accessToken}`,
    });
  });

  it("rejects a cookie claiming a known user with an access token the auth server does not recognise", async () => {
    installStubAuthServer({ mode: "normal", users: [USER_A, USER_B] });
    const forged = sessionCookie({
      id: USER_A.id,
      accessToken: "forged-access-token",
      refreshToken: "forged-refresh-token",
    });
    useCookies([forged]);

    const error = await captureRejection(requireSession());

    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error).toMatchObject({ code: "session_invalid" });
  });

  it("redirects a proxy dashboard request whose cookie claims a known user with an unrecognised access token", async () => {
    installStubAuthServer({ mode: "normal", users: [USER_A, USER_B] });
    const forged = sessionCookie({
      id: USER_A.id,
      accessToken: "forged-access-token",
      refreshToken: "forged-refresh-token",
    });

    const response = await proxy(
      proxyRequest("/dashboard", {
        cookies: [forged],
        headers: { "x-user-id": USER_A.id },
      }),
    );

    expect(response.headers.get("location")).toBe(SIGN_IN_URL);
  });
});
