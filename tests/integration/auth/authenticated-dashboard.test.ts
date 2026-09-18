// Exercises proxy + @supabase/ssr + supabase-js + lib/auth + the dashboard
// layout against a stub auth server. It does not prove a real sign-in works.
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  headersCookieStore,
  installStubAuthServer,
  proxyRequest,
  sessionCookie,
  USER_A,
} from "@/tests/security/auth/support/stub-auth-server";

type HarnessCookieStore = ReturnType<typeof headersCookieStore>;

/**
 * The cookie store `next/headers` hands to server code in each test. Held in a
 * hoisted slot rather than passed through `mockResolvedValue`, because the
 * harness store is not assignable to Next's `ReadonlyRequestCookies` type and
 * the only way to force it would be a banned type escape hatch.
 */
const requestCookies = vi.hoisted(() => {
  const slot: { store: HarnessCookieStore | undefined } = { store: undefined };
  return slot;
});

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => {
    if (!requestCookies.store) {
      throw new Error("No cookie store was set for this test");
    }
    return requestCookies.store;
  }),
}));

import { renderToStaticMarkup } from "react-dom/server";

import DashboardPage from "@/app/(dashboard)/dashboard/page";
import DashboardLayout from "@/app/(dashboard)/layout";
import { requireSession } from "@/lib/auth/require-session";
import proxy from "@/proxy";

const SIGNED_IN_USERS = [USER_A];

afterEach(() => {
  vi.unstubAllGlobals();
  requestCookies.store = undefined;
});

function nonceFromPolicy(policy: string | null) {
  const match = policy?.match(/'nonce-([^']+)'/);
  const nonce = match?.[1];
  if (!nonce) {
    throw new Error(`No nonce found in Content-Security-Policy: ${policy}`);
  }
  return nonce;
}

function userLookups(requests: { method: string; path: string }[]) {
  return requests.filter(
    (request) => request.method === "GET" && request.path === "/auth/v1/user",
  );
}

describe("proxy with an authenticated session", () => {
  it.each(["/dashboard", "/dashboard/systems"])(
    "lets an authenticated request to %s through without redirecting",
    async (path) => {
      installStubAuthServer({ mode: "normal", users: SIGNED_IN_USERS });

      const response = await proxy(
        proxyRequest(path, { cookies: [sessionCookie(USER_A)] }),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("x-middleware-next")).toBe("1");
    },
  );

  it.each(["/dashboard", "/dashboard/systems"])(
    "forwards the CSP nonce to server rendering of %s, matching the response policy",
    async (path) => {
      installStubAuthServer({ mode: "normal", users: SIGNED_IN_USERS });

      const response = await proxy(
        proxyRequest(path, { cookies: [sessionCookie(USER_A)] }),
      );

      const overridden =
        response.headers
          .get("x-middleware-override-headers")
          ?.split(",")
          .map((name) => name.trim().toLowerCase()) ?? [];
      expect(overridden).toContain("x-nonce");
      expect(overridden).toContain("content-security-policy");

      const responsePolicy = response.headers.get("content-security-policy");
      const forwardedPolicy = response.headers.get(
        "x-middleware-request-content-security-policy",
      );
      const forwardedNonce = response.headers.get(
        "x-middleware-request-x-nonce",
      );

      expect(forwardedPolicy).toBe(responsePolicy);
      expect(forwardedNonce).toBe(nonceFromPolicy(responsePolicy));
    },
  );

  it("forwards the session cookie unchanged to server rendering", async () => {
    installStubAuthServer({ mode: "normal", users: SIGNED_IN_USERS });
    const cookie = sessionCookie(USER_A);

    const response = await proxy(
      proxyRequest("/dashboard", { cookies: [cookie] }),
    );

    expect(response.headers.get("x-middleware-request-cookie")).toBe(
      `${cookie.name}=${cookie.value}`,
    );
  });

  it("applies every security header to an authenticated dashboard response", async () => {
    installStubAuthServer({ mode: "normal", users: SIGNED_IN_USERS });

    const response = await proxy(
      proxyRequest("/dashboard", { cookies: [sessionCookie(USER_A)] }),
    );

    const policy = response.headers.get("content-security-policy");
    expect(policy).toContain("default-src 'self'");
    expect(policy).toMatch(
      /script-src 'self' 'nonce-[0-9a-f]{32}' 'strict-dynamic'/,
    );
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("form-action 'self'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(response.headers.get("permissions-policy")).toBe(
      "camera=(), microphone=(), geolocation=(), interest-cohort=()",
    );
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );
  });

  it("sets no cookie when the session is valid and nothing was refreshed", async () => {
    const { requests } = installStubAuthServer({
      mode: "normal",
      users: SIGNED_IN_USERS,
    });

    const response = await proxy(
      proxyRequest("/dashboard", { cookies: [sessionCookie(USER_A)] }),
    );

    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.cookies.getAll()).toEqual([]);
    expect(
      requests.filter((request) => request.path.startsWith("/auth/v1/token")),
    ).toEqual([]);
  });

  it("validates the session with the auth server rather than trusting the cookie", async () => {
    const { requests } = installStubAuthServer({
      mode: "normal",
      users: SIGNED_IN_USERS,
    });

    await proxy(
      proxyRequest("/dashboard", { cookies: [sessionCookie(USER_A)] }),
    );

    expect(requests).toContainEqual({
      method: "GET",
      path: "/auth/v1/user",
      authorization: `Bearer ${USER_A.accessToken}`,
    });
  });

  it("issues a different nonce on each request", async () => {
    installStubAuthServer({ mode: "normal", users: SIGNED_IN_USERS });

    const first = await proxy(
      proxyRequest("/dashboard", { cookies: [sessionCookie(USER_A)] }),
    );
    const second = await proxy(
      proxyRequest("/dashboard", { cookies: [sessionCookie(USER_A)] }),
    );

    const firstNonce = nonceFromPolicy(
      first.headers.get("content-security-policy"),
    );
    const secondNonce = nonceFromPolicy(
      second.headers.get("content-security-policy"),
    );
    expect(firstNonce).not.toBe(secondNonce);
    expect(first.headers.get("x-middleware-request-x-nonce")).toBe(firstNonce);
    expect(second.headers.get("x-middleware-request-x-nonce")).toBe(
      secondNonce,
    );
  });

  it("lets an authenticated request to a non-dashboard route through without redirecting", async () => {
    installStubAuthServer({ mode: "normal", users: SIGNED_IN_USERS });

    const response = await proxy(
      proxyRequest("/", { cookies: [sessionCookie(USER_A)] }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-request-x-nonce")).toBe(
      nonceFromPolicy(response.headers.get("content-security-policy")),
    );
  });
});

describe("dashboard layout with an authenticated session", () => {
  it("renders its children for an authenticated request", async () => {
    installStubAuthServer({ mode: "normal", users: SIGNED_IN_USERS });
    requestCookies.store = headersCookieStore([sessionCookie(USER_A)]);
    const marker = createElement("main", { id: "dashboard-marker" });

    const html = renderToStaticMarkup(
      await DashboardLayout({ children: marker }),
    );

    expect(html).toContain('id="dashboard-marker"');
  });

  it("offers sign-out as a form, never a link", async () => {
    installStubAuthServer({ mode: "normal", users: SIGNED_IN_USERS });
    requestCookies.store = headersCookieStore([sessionCookie(USER_A)]);

    const html = renderToStaticMarkup(
      await DashboardLayout({ children: null }),
    );

    // Codex review of PR #6, finding F3: there was no way to end a session.
    expect(html).toMatch(
      /<form[^>]*>[\s\S]*<button[^>]*type="submit"[^>]*>Sign out<\/button>/,
    );
    expect(html).not.toMatch(/<a[^>]*>Sign out<\/a>/);
  });

  it("writes no cookies while rendering for a valid session", async () => {
    installStubAuthServer({ mode: "normal", users: SIGNED_IN_USERS });
    const store = headersCookieStore([sessionCookie(USER_A)]);
    requestCookies.store = store;

    await DashboardLayout({ children: "dashboard" });

    expect(store.set).not.toHaveBeenCalled();
  });
});

describe("dashboard page with an authenticated session", () => {
  it("renders the placeholder dashboard for an authenticated request", async () => {
    installStubAuthServer({ mode: "normal", users: SIGNED_IN_USERS });
    requestCookies.store = headersCookieStore([sessionCookie(USER_A)]);

    const html = renderToStaticMarkup(await DashboardPage());

    expect(html).toContain("<h1");
    expect(html).toContain("Dashboard");
  });

  it("renders nothing identifying the signed-in user", async () => {
    installStubAuthServer({ mode: "normal", users: SIGNED_IN_USERS });
    requestCookies.store = headersCookieStore([sessionCookie(USER_A)]);

    const html = renderToStaticMarkup(await DashboardPage());

    expect(html).not.toContain(USER_A.id);
    expect(html).not.toContain("@example.test");
  });
});

describe("requireSession with an authenticated session", () => {
  it("resolves the signed-in user's id from the session", async () => {
    installStubAuthServer({ mode: "normal", users: SIGNED_IN_USERS });
    requestCookies.store = headersCookieStore([sessionCookie(USER_A)]);

    await expect(requireSession()).resolves.toEqual({ userId: USER_A.id });
  });

  it("asks the auth server exactly once per invocation", async () => {
    const { requests } = installStubAuthServer({
      mode: "normal",
      users: SIGNED_IN_USERS,
    });
    requestCookies.store = headersCookieStore([sessionCookie(USER_A)]);

    await requireSession();
    expect(userLookups(requests)).toEqual([
      {
        method: "GET",
        path: "/auth/v1/user",
        authorization: `Bearer ${USER_A.accessToken}`,
      },
    ]);

    await requireSession();
    expect(userLookups(requests)).toHaveLength(2);
  });
});
