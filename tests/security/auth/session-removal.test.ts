import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * auth-js deletes the session after any non-retryable refresh failure, a 429
 * caused by other people's traffic included. The proxy already refuses to
 * forward that deletion (TASK-003d); this pins the same guarantee for route
 * handlers and server actions, and for the proxy's own background refresh
 * (TASK-003i, review finding F2).
 */

const jar = vi.hoisted(() => new Map<string, string>());
/** Every cookie write, so removals of cookies this request cannot see show. */
const cookieWrites = vi.hoisted(() => [] as { name: string; value: string }[]);

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    get: (name: string) => {
      const value = jar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string, options?: { maxAge?: number }) => {
      cookieWrites.push({ name, value });
      if (value === "" || options?.maxAge === 0) {
        jar.delete(name);
      } else {
        jar.set(name, value);
      }
    },
  }),
}));

import { AuthenticationError, SessionLookupError } from "@/lib/auth/errors";
import { requireSession } from "@/lib/auth/require-session";
import { signOut } from "@/lib/auth/sign-in/sign-out";
import proxy from "@/proxy";
import { createProxySessionClient } from "@/lib/database/proxy-session-client";
import { resolveSessionUser } from "@/lib/auth/resolve-session-user";
import {
  installStubAuthServer,
  proxyRequest,
  sessionCookie,
  sessionCookieName,
  USER_A,
} from "./support/stub-auth-server";

afterEach(() => {
  vi.unstubAllGlobals();
  jar.clear();
  cookieWrites.length = 0;
});

function holdExpiredSession() {
  const cookie = sessionCookie(USER_A, { expiresInSeconds: -60 });
  jar.set(cookie.name, cookie.value);
  return cookie;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject, but it resolved");
    },
    (error: unknown) => error,
  );
}

describe("security: resolving a session in a handler keeps it through hiccups", () => {
  it.each([
    ["a 429", 429],
    ["a 408", 408],
    ["a 409", 409],
    // 5xx is left out on purpose: auth-js retries it with a long backoff, so
    // the test would measure that timeout rather than this rule.
  ])(
    "deletes no session cookie when the refresh gets %s",
    async (_label, status) => {
      installStubAuthServer({ mode: "status", status });
      const cookie = holdExpiredSession();

      const error = await rejectionOf(requireSession());

      expect(error).toBeInstanceOf(SessionLookupError);
      expect(jar.get(cookie.name)).toBe(cookie.value);
    },
  );

  it("clears the session cookie once the auth server rejects the credential", async () => {
    // No refreshed user, so the stub answers refresh_token_not_found (400).
    installStubAuthServer({ mode: "normal", users: [USER_A] });
    const cookie = holdExpiredSession();

    const error = await rejectionOf(requireSession());

    expect(error).toBeInstanceOf(AuthenticationError);
    expect(jar.has(cookie.name)).toBe(false);
  });

  it("keeps a valid session's cookie untouched", async () => {
    installStubAuthServer({ mode: "normal", users: [USER_A] });
    const cookie = sessionCookie(USER_A);
    jar.set(cookie.name, cookie.value);

    await expect(requireSession()).resolves.toEqual({ userId: USER_A.id });
    expect(jar.get(cookie.name)).toBe(cookie.value);
  });
});

describe("security: the proxy's background refresh cannot hide the session", () => {
  // Creating a session client subscribes to auth events, which makes auth-js
  // refresh an expired session on its own and, on a failure, delete it. With
  // any awaited work before the proxy resolves, that deletion used to reach
  // the request and read as "signed out" — a 429 signing the person out.
  it("resolves as unverifiable after a delay, with the session intact", async () => {
    installStubAuthServer({ mode: "status", status: 429 });
    const cookie = sessionCookie(USER_A, { expiresInSeconds: -60 });
    const request = proxyRequest("/dashboard", { cookies: [cookie] });

    const { supabase } = createProxySessionClient(request);
    await new Promise((resolve) => setTimeout(resolve, 60));

    // The request still carries the session, so the background deletion did
    // not reach it...
    expect(request.cookies.get(sessionCookieName())?.value).toBe(cookie.value);
    // ...and because it does, "no session" is not a verdict: the proxy passes
    // the same flag, computed from the request's cookies.
    await expect(
      resolveSessionUser(supabase.auth, { hadStoredSession: true }),
    ).rejects.toBeInstanceOf(SessionLookupError);
  });
});

describe("security: the proxy keeps a session it could not verify", () => {
  it("answers 503 and clears nothing when the background refresh got a 429", async () => {
    installStubAuthServer({ mode: "status", status: 429 });
    const cookie = sessionCookie(USER_A, { expiresInSeconds: -60 });

    const response = await proxy(
      proxyRequest("/dashboard", { cookies: [cookie] }),
    );

    expect(response.status).toBe(503);
    expect(
      response.headers
        .getSetCookie()
        .filter((header) => /Max-Age=0/i.test(header)),
    ).toEqual([]);
  });
});

describe("security: a cookie auth-js would not accept is not a stored session", () => {
  // Only a session auth-js would accept counts as "this request had one".
  // Otherwise a cookie holding nothing but an expiry would turn every "no
  // session" into "unverifiable": 503 on every dashboard visit, and a cookie
  // nothing would ever clear (review of TASK-003i).
  const partial = () => ({
    name: sessionCookieName(),
    value: `base64-${Buffer.from(JSON.stringify({ expires_at: 9_999_999_999 })).toString("base64url")}`,
  });

  it("resolves as signed out in requireSession, not as a lookup failure", async () => {
    installStubAuthServer({ mode: "normal", users: [USER_A] });
    const cookie = partial();
    jar.set(cookie.name, cookie.value);

    const error = await rejectionOf(requireSession());

    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error).not.toBeInstanceOf(SessionLookupError);
  });

  it("sends a proxied dashboard request to sign-in instead of answering 503", async () => {
    installStubAuthServer({ mode: "normal", users: [USER_A] });

    const response = await proxy(
      proxyRequest("/dashboard", { cookies: [partial()] }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/sign-in",
    );
  });
});

describe("security: signing out always signs out", () => {
  it("clears the session cookie even when the auth server fails", async () => {
    installStubAuthServer({ mode: "status", status: 500 });
    const cookie = sessionCookie(USER_A);
    jar.set(cookie.name, cookie.value);

    await signOut();

    expect(jar.has(cookie.name)).toBe(false);
  });

  it("clears chunked session cookies and leaves a pending sign-in alone", async () => {
    installStubAuthServer({ mode: "status", status: 500 });
    const name = sessionCookieName();
    jar.set(`${name}.0`, "first-half");
    jar.set(`${name}.1`, "second-half");
    jar.set(`${name}-code-verifier`, "verifier");
    jar.set("a50_sign_in_flow", "ticket");

    await signOut();

    // auth-js clears the PKCE verifiers of pending flows on sign-out; a
    // deliberate sign-out ending a half-finished sign-in is reasonable.
    expect([...jar.keys()]).toEqual(["a50_sign_in_flow"]);
  });

  it("expires the session cookie this request cannot even see", async () => {
    // What the proxy leaves behind when a refresh is over the limit: the
    // browser holds the session, but it was stripped from this request, so
    // neither auth-js nor a cookie-reading helper can find anything to clear.
    installStubAuthServer({ mode: "normal", users: [USER_A] });
    const name = sessionCookieName();
    jar.set("a50_sign_in_flow", "ticket");

    await signOut();

    const expired = cookieWrites
      .filter((write) => write.value === "")
      .map((write) => write.name);
    expect(expired).toContain(name);
    expect(expired).toContain(`${name}.0`);
    expect(expired).toContain(`${name}.1`);
    // A sign-in in progress is left alone.
    expect(expired).not.toContain("a50_sign_in_flow");
    expect(jar.get("a50_sign_in_flow")).toBe("ticket");
  });

  it("clears the cookie when there is no session for auth-js to remove", async () => {
    // What the proxy leaves behind when a refresh is over the limit: the
    // browser still holds the cookie, but this request cannot see it.
    installStubAuthServer({ mode: "normal", users: [USER_A] });
    const name = sessionCookieName();
    jar.set(name, "base64-not-a-session");

    await signOut();

    expect(jar.has(name)).toBe(false);
  });
});
