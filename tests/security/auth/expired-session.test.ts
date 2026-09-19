import { afterEach, describe, expect, it, vi } from "vitest";

// The sign-in path now reaches the rate limiter, a server-only module.
vi.mock("server-only", () => ({}));

type RequestCookie = { name: string; value: string };

/**
 * The cookies `next/headers` hands to server code for the current test. A plain
 * async function rather than `vi.fn`, so `restoreMocks` cannot strip it between
 * tests.
 */
const requestCookieJar = vi.hoisted(() => ({
  cookies: [] as { name: string; value: string }[],
}));

vi.mock("next/headers", async () => {
  const { headersCookieStore } = await import("./support/stub-auth-server");
  return {
    cookies: async () => headersCookieStore(requestCookieJar.cookies),
  };
});

import DashboardLayout from "@/app/(dashboard)/layout";
import { AuthenticationError, SessionLookupError } from "@/lib/auth/errors";
import { requireSession } from "@/lib/auth/require-session";
import proxy from "@/proxy";

import {
  installStubAuthServer,
  proxyRequest,
  sessionCookie,
  sessionCookieName,
  USER_A,
} from "./support/stub-auth-server";

const SIGN_IN_URL = "http://localhost:3000/sign-in";

const REFRESHED_USER_A = {
  ...USER_A,
  accessToken: "refreshed-access",
  refreshToken: "refreshed-refresh",
};

const REFRESH_REQUEST_PATH = "/auth/v1/token?grant_type=refresh_token";

afterEach(() => {
  vi.unstubAllGlobals();
  requestCookieJar.cookies = [];
});

function useRequestCookies(cookies: RequestCookie[]) {
  requestCookieJar.cookies = cookies;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject, but it resolved");
    },
    (error: unknown) => error,
  );
}

function redirectDigest(error: unknown): string | undefined {
  if (error instanceof Error && "digest" in error) {
    return typeof error.digest === "string" ? error.digest : undefined;
  }
  return undefined;
}

async function expectLayoutRedirectsToSignIn() {
  const error = await rejectionOf(
    Promise.resolve(DashboardLayout({ children: null })),
  );

  const digest = redirectDigest(error);
  expect(digest, `layout threw a non-redirect: ${String(error)}`).toMatch(
    /^NEXT_REDIRECT/,
  );
  expect(digest?.split(";")).toContain("/sign-in");
}

function expectRedirectToSignIn(response: Response) {
  expect(response.status).toBeGreaterThanOrEqual(300);
  expect(response.status).toBeLessThan(400);
  expect(response.headers.get("location")).toBe(SIGN_IN_URL);
}

function sessionSetCookieHeaders(response: Response) {
  return response.headers
    .getSetCookie()
    .filter((header) => header.startsWith(`${sessionCookieName()}=`));
}

function isClearingSetCookie(header: string) {
  const [pair = "", ...attributes] = header
    .split(";")
    .map((part) => part.trim());
  const value = pair.slice(pair.indexOf("=") + 1);
  if (value !== "") {
    return false;
  }
  return attributes.some((attribute) => {
    const [key = "", attributeValue = ""] = attribute.split("=");
    if (key.toLowerCase() === "max-age") {
      return Number(attributeValue) <= 0;
    }
    if (key.toLowerCase() === "expires") {
      return Date.parse(attributeValue) < Date.now();
    }
    return false;
  });
}

function parseCookieHeader(header: string): RequestCookie[] {
  return header
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => ({
      name: part.slice(0, part.indexOf("=")),
      value: part.slice(part.indexOf("=") + 1),
    }));
}

function decodeSessionCookieValue(value: string): unknown {
  expect(value.startsWith("base64-")).toBe(true);
  return JSON.parse(
    Buffer.from(value.slice("base64-".length), "base64url").toString("utf8"),
  );
}

const GARBAGE_COOKIE_VALUES = [
  ["a value without the base64- prefix", "not-a-session-at-all"],
  ["a base64- value with invalid base64url characters", "base64-!!!%%%***"],
  [
    "a base64- value whose payload is not JSON",
    `base64-${Buffer.from("{not json").toString("base64url")}`,
  ],
  [
    "a base64- value whose JSON is not a session",
    `base64-${Buffer.from(JSON.stringify({ hello: "world" })).toString("base64url")}`,
  ],
] as const;

describe("security: a refresh the auth server cannot answer keeps the session", () => {
  // auth-js deletes the session after any non-retryable refresh failure,
  // 429 included. The auth server counts refreshes per IP, and every
  // server-side refresh comes from this application's IP, so anonymous junk
  // cookies could exhaust the limit and have everyone else signed out.
  // Codex review of PR #6, finding F2.
  const expiredCookie = () => sessionCookie(USER_A, { expiresInSeconds: -60 });

  // Non-retryable answers that say nothing about the credential. (Retryable
  // ones — 5xx, network failures — already keep the session in auth-js, after
  // a long backoff.)
  it.each([
    ["a 429", { mode: "status", status: 429 } as const],
    ["a 408", { mode: "status", status: 408 } as const],
    ["a 409", { mode: "status", status: 409 } as const],
  ])(
    "deletes no session cookie when the refresh gets %s",
    async (_label, behaviour) => {
      installStubAuthServer(behaviour);

      for (const path of ["/dashboard", "/"]) {
        const response = await proxy(
          proxyRequest(path, { cookies: [expiredCookie()] }),
        );

        expect(
          sessionSetCookieHeaders(response).filter(isClearingSetCookie),
          `clearing Set-Cookie on ${path}`,
        ).toEqual([]);
      }
    },
  );

  it("still serves the dashboard as unavailable rather than signing out", async () => {
    installStubAuthServer({ mode: "status", status: 429 });

    const response = await proxy(
      proxyRequest("/dashboard", { cookies: [expiredCookie()] }),
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("security: an expired session is rejected", () => {
  describe("expired access token whose refresh the auth server rejects", () => {
    const expiredCookie = () =>
      sessionCookie(USER_A, { expiresInSeconds: -60 });

    it("treats the session as invalid in requireSession, not as a lookup failure", async () => {
      const { requests } = installStubAuthServer({
        mode: "normal",
        users: [USER_A],
      });
      useRequestCookies([expiredCookie()]);

      const error = await rejectionOf(requireSession());

      expect(error).not.toBeInstanceOf(SessionLookupError);
      expect(error).toBeInstanceOf(AuthenticationError);
      expect(error).toMatchObject({ code: "session_invalid" });
      expect(requests).toContainEqual(
        expect.objectContaining({
          method: "POST",
          path: REFRESH_REQUEST_PATH,
        }),
      );
    });

    it("redirects the dashboard layout to sign-in instead of rendering an error", async () => {
      installStubAuthServer({ mode: "normal", users: [USER_A] });
      useRequestCookies([expiredCookie()]);

      await expectLayoutRedirectsToSignIn();
    });

    it("redirects a proxied dashboard request to sign-in", async () => {
      installStubAuthServer({ mode: "normal", users: [USER_A] });

      const response = await proxy(
        proxyRequest("/dashboard", { cookies: [expiredCookie()] }),
      );

      expectRedirectToSignIn(response);
      expect(response.headers.get("cache-control")).toContain("no-store");
    });

    it("clears the rejected session cookie on the proxy redirect", async () => {
      installStubAuthServer({ mode: "normal", users: [USER_A] });

      const response = await proxy(
        proxyRequest("/dashboard", { cookies: [expiredCookie()] }),
      );

      expectRedirectToSignIn(response);
      const sessionHeaders = sessionSetCookieHeaders(response);
      expect(sessionHeaders.length).toBeGreaterThan(0);
      expect(
        sessionHeaders.every(isClearingSetCookie),
        `session Set-Cookie headers: ${JSON.stringify(sessionHeaders)}`,
      ).toBe(true);
      expect(response.cookies.get(sessionCookieName())?.value).toBe("");
    });
  });

  describe("revoked session with an unexpired access token", () => {
    it("treats the session as invalid in requireSession", async () => {
      const { requests } = installStubAuthServer({
        mode: "normal",
        // The auth server no longer recognises USER_A's access token.
        users: [],
      });
      useRequestCookies([sessionCookie(USER_A)]);

      const error = await rejectionOf(requireSession());

      expect(error).not.toBeInstanceOf(SessionLookupError);
      expect(error).toBeInstanceOf(AuthenticationError);
      expect(error).toMatchObject({ code: "session_invalid" });
      expect(requests).toContainEqual({
        method: "GET",
        path: "/auth/v1/user",
        authorization: `Bearer ${USER_A.accessToken}`,
      });
    });

    it("redirects the dashboard layout to sign-in", async () => {
      installStubAuthServer({ mode: "normal", users: [] });
      useRequestCookies([sessionCookie(USER_A)]);

      await expectLayoutRedirectsToSignIn();
    });

    it("redirects a proxied dashboard request to sign-in", async () => {
      installStubAuthServer({ mode: "normal", users: [] });

      const response = await proxy(
        proxyRequest("/dashboard", { cookies: [sessionCookie(USER_A)] }),
      );

      expectRedirectToSignIn(response);
    });
  });

  describe("session revoked server-side, as real GoTrue reports it", () => {
    it("treats the session as missing in requireSession", async () => {
      installStubAuthServer({ mode: "revoked" });
      useRequestCookies([sessionCookie(USER_A)]);

      const error = await rejectionOf(requireSession());

      expect(error).not.toBeInstanceOf(SessionLookupError);
      expect(error).toBeInstanceOf(AuthenticationError);
      expect(error).toMatchObject({ code: "session_missing" });
    });

    it("redirects a proxied dashboard request to sign-in and clears the session cookie", async () => {
      installStubAuthServer({ mode: "revoked" });

      const response = await proxy(
        proxyRequest("/dashboard", { cookies: [sessionCookie(USER_A)] }),
      );

      expectRedirectToSignIn(response);
      const sessionHeaders = sessionSetCookieHeaders(response);
      expect(sessionHeaders.length).toBeGreaterThan(0);
      expect(
        sessionHeaders.every(isClearingSetCookie),
        `session Set-Cookie headers: ${JSON.stringify(sessionHeaders)}`,
      ).toBe(true);
    });
  });

  describe("session past its absolute or idle limit (TASK-003e)", () => {
    it("treats the session as invalid in requireSession, not as a lookup failure", async () => {
      installStubAuthServer({ mode: "session-expired" });
      useRequestCookies([sessionCookie(USER_A)]);

      const error = await rejectionOf(requireSession());

      expect(error).not.toBeInstanceOf(SessionLookupError);
      expect(error).toBeInstanceOf(AuthenticationError);
    });

    it("redirects a proxied dashboard request to sign-in when the lookup is refused (403)", async () => {
      // The access token is still unexpired, so no refresh happens and auth-js
      // keeps the cookie. Every request carrying it is refused, and the next
      // sign-in overwrites it; the proxy does not delete cookies by name, which
      // could take a pending link's PKCE verifier with it (review finding F1).
      installStubAuthServer({ mode: "session-expired" });

      const response = await proxy(
        proxyRequest("/dashboard", { cookies: [sessionCookie(USER_A)] }),
      );

      expectRedirectToSignIn(response);
    });

    it("redirects to sign-in and clears the session cookie when the refresh is refused (400)", async () => {
      installStubAuthServer({ mode: "session-expired" });

      const response = await proxy(
        proxyRequest("/dashboard", {
          cookies: [sessionCookie(USER_A, { expiresInSeconds: -60 })],
        }),
      );

      expectRedirectToSignIn(response);
      const sessionHeaders = sessionSetCookieHeaders(response);
      expect(sessionHeaders.length).toBeGreaterThan(0);
      expect(
        sessionHeaders.every(isClearingSetCookie),
        `session Set-Cookie headers: ${JSON.stringify(sessionHeaders)}`,
      ).toBe(true);
    });
  });

  describe("garbage session cookie", () => {
    it.each(GARBAGE_COOKIE_VALUES)(
      "treats %s as unauthenticated in requireSession",
      async (_description, value) => {
        installStubAuthServer({ mode: "normal", users: [USER_A] });
        useRequestCookies([{ name: sessionCookieName(), value }]);

        const error = await rejectionOf(requireSession());

        expect(error).not.toBeInstanceOf(SessionLookupError);
        expect(error, `threw: ${String(error)}`).toBeInstanceOf(
          AuthenticationError,
        );
      },
    );

    it.each(GARBAGE_COOKIE_VALUES)(
      "redirects the dashboard layout to sign-in for %s",
      async (_description, value) => {
        installStubAuthServer({ mode: "normal", users: [USER_A] });
        useRequestCookies([{ name: sessionCookieName(), value }]);

        await expectLayoutRedirectsToSignIn();
      },
    );

    it.each(GARBAGE_COOKIE_VALUES)(
      "redirects a proxied dashboard request to sign-in for %s rather than failing",
      async (_description, value) => {
        installStubAuthServer({ mode: "normal", users: [USER_A] });

        const response = await proxy(
          proxyRequest("/dashboard", {
            cookies: [{ name: sessionCookieName(), value }],
          }),
        );

        expect(response.status).not.toBe(500);
        expectRedirectToSignIn(response);
      },
    );
  });

  describe("expired access token with a successful refresh", () => {
    async function proxyWithRefreshableSession() {
      const expired = sessionCookie(USER_A, { expiresInSeconds: -60 });
      const { requests } = installStubAuthServer({
        mode: "normal",
        users: [USER_A],
        refreshedUsers: [REFRESHED_USER_A],
      });

      const response = await proxy(
        proxyRequest("/dashboard", { cookies: [expired] }),
      );

      return { response, requests, expired };
    }

    it("lets the dashboard request through after refreshing the session", async () => {
      const { response, requests } = await proxyWithRefreshableSession();

      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      expect(requests).toContainEqual(
        expect.objectContaining({
          method: "POST",
          path: REFRESH_REQUEST_PATH,
        }),
      );
    });

    it("sets the refreshed session cookie on the response", async () => {
      const { response, expired } = await proxyWithRefreshableSession();

      const refreshedValue = response.cookies.get(sessionCookieName())?.value;
      expect(refreshedValue).toBeDefined();
      expect(refreshedValue).not.toBe(expired.value);
      expect(decodeSessionCookieValue(refreshedValue ?? "")).toMatchObject({
        access_token: REFRESHED_USER_A.accessToken,
        refresh_token: REFRESHED_USER_A.refreshToken,
      });
    });

    it("forwards the refreshed cookie, not the expired one, to server components", async () => {
      const { response, expired } = await proxyWithRefreshableSession();

      const forwardedHeader = response.headers.get(
        "x-middleware-request-cookie",
      );
      expect(forwardedHeader).not.toBeNull();
      const forwarded = parseCookieHeader(forwardedHeader ?? "");
      const forwardedSession = forwarded.find(
        (cookie) => cookie.name === sessionCookieName(),
      );

      expect(forwardedSession).toBeDefined();
      expect(forwardedSession?.value).not.toBe(expired.value);
      expect(forwardedSession?.value).toBe(
        response.cookies.get(sessionCookieName())?.value,
      );
      expect(forwardedHeader).not.toContain(expired.value);
    });

    it("forwards a cookie that server components resolve to the same user", async () => {
      const { response } = await proxyWithRefreshableSession();

      const forwarded = parseCookieHeader(
        response.headers.get("x-middleware-request-cookie") ?? "",
      );
      useRequestCookies(forwarded);

      await expect(requireSession()).resolves.toEqual({ userId: USER_A.id });
    });

    it("keeps the CSP nonce on both the forwarded request and the response", async () => {
      const { response } = await proxyWithRefreshableSession();

      const overridden = (
        response.headers.get("x-middleware-override-headers") ?? ""
      ).split(",");
      expect(overridden).toContain("x-nonce");
      expect(overridden).toContain("content-security-policy");
      expect(overridden).toContain("cookie");

      const nonce = response.headers.get("x-middleware-request-x-nonce");
      expect(nonce).toMatch(/^[0-9a-f]{32}$/);
      const policy = response.headers.get("content-security-policy");
      expect(policy).toContain(`'nonce-${nonce ?? ""}'`);
      expect(
        response.headers.get("x-middleware-request-content-security-policy"),
      ).toBe(policy);
    });

    it("marks the response as not storable by shared caches", async () => {
      const { response } = await proxyWithRefreshableSession();

      expect(response.headers.get("cache-control")).toContain("no-store");
    });
  });
});
