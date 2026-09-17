import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DashboardLayout from "@/app/(dashboard)/layout";
import { AuthenticationError, SessionLookupError } from "@/lib/auth/errors";
import { requireSession } from "@/lib/auth/require-session";
import { serverEnv } from "@/lib/env/server-env";
import { logger } from "@/lib/logging/logger";
import proxy from "@/proxy";

import {
  installStubAuthServer,
  proxyRequest,
  sessionCookie,
  USER_A,
} from "./support/stub-auth-server";

const requestCookies = vi.hoisted(() => ({
  list: [] as { name: string; value: string }[],
}));

// A server-component cookie store: readable, and throwing on write as Next.js
// does while rendering. Built inline rather than from Next.js internals, which
// are not a stable import path.
vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => requestCookies.list,
    set: () => {
      throw new Error("Cookies can only be modified in a Server Action");
    },
  }),
}));

const DASHBOARD_CONTENT = "dashboard-content-must-not-render";

function useRequestCookies(cookieList: { name: string; value: string }[]) {
  requestCookies.list = cookieList;
}

type Settled =
  | { outcome: "resolved"; value: unknown }
  | { outcome: "rejected"; error: unknown };

async function settle(promise: Promise<unknown>): Promise<Settled> {
  try {
    return { outcome: "resolved", value: await promise };
  } catch (error) {
    return { outcome: "rejected", error };
  }
}

function redirectDigest(error: unknown) {
  if (typeof error !== "object" || error === null || !("digest" in error)) {
    return undefined;
  }
  return typeof error.digest === "string" ? error.digest : undefined;
}

function renderDashboardLayout() {
  return DashboardLayout({ children: DASHBOARD_CONTENT });
}

async function expectLayoutFailsClosedWithLookupError() {
  const result = await settle(renderDashboardLayout());

  expect(result.outcome).toBe("rejected");
  if (result.outcome !== "rejected") {
    return;
  }
  expect(result.error).toBeInstanceOf(SessionLookupError);
  expect(result.error).not.toBeInstanceOf(AuthenticationError);
  expect(redirectDigest(result.error) ?? "").not.toMatch(/^NEXT_REDIRECT/);
}

async function expectLayoutRedirectsToSignIn() {
  const result = await settle(renderDashboardLayout());

  expect(result.outcome).toBe("rejected");
  if (result.outcome !== "rejected") {
    return;
  }
  const digest = redirectDigest(result.error);
  expect(digest).toMatch(/^NEXT_REDIRECT/);
  expect(digest).toContain("/sign-in");
  expect(result.error).not.toBeInstanceOf(SessionLookupError);
}

beforeEach(() => {
  useRequestCookies([sessionCookie(USER_A)]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session lookup when the auth server cannot answer", () => {
  describe("network failure", () => {
    beforeEach(() => {
      installStubAuthServer({ mode: "network-failure" });
    });

    it("rejects requireSession with a SessionLookupError for a valid session cookie", async () => {
      const result = await settle(requireSession());

      expect(result.outcome).toBe("rejected");
      if (result.outcome !== "rejected") {
        return;
      }
      expect(result.error).toBeInstanceOf(SessionLookupError);
      expect(result.error).not.toBeInstanceOf(AuthenticationError);
      expect(result.error).toMatchObject({ code: "session_lookup_failed" });
    });

    it("fails the dashboard layout closed with an error rather than a sign-in redirect", async () => {
      await expectLayoutFailsClosedWithLookupError();
    });
  });

  describe.each([500, 503, 429])("auth server status %i", (status) => {
    beforeEach(() => {
      installStubAuthServer({ mode: "status", status });
    });

    it("rejects requireSession with a SessionLookupError", async () => {
      const result = await settle(requireSession());

      expect(result.outcome).toBe("rejected");
      if (result.outcome !== "rejected") {
        return;
      }
      expect(result.error).toBeInstanceOf(SessionLookupError);
      expect(result.error).not.toBeInstanceOf(AuthenticationError);
      expect(result.error).toMatchObject({ code: "session_lookup_failed" });
    });

    it("fails the dashboard layout closed with an error rather than a sign-in redirect", async () => {
      await expectLayoutFailsClosedWithLookupError();
    });

    it("serves an uncacheable 503 from the proxy instead of forwarding the dashboard request", async () => {
      const response = await proxy(
        proxyRequest("/dashboard", { cookies: [sessionCookie(USER_A)] }),
      );

      expectSessionUnavailable(response);
    });
  });

  describe.each([404, 408, 409])(
    "unexpected auth server status %i",
    (status) => {
      beforeEach(() => {
        installStubAuthServer({ mode: "status", status });
      });

      it("fails closed as a lookup failure rather than signing the user out", async () => {
        const result = await settle(requireSession());

        expect(result.outcome).toBe("rejected");
        if (result.outcome !== "rejected") {
          return;
        }
        expect(result.error).toBeInstanceOf(SessionLookupError);
        expect(result.error).not.toBeInstanceOf(AuthenticationError);
      });

      it("serves a 503 from the proxy rather than a sign-in redirect", async () => {
        const response = await proxy(
          proxyRequest("/dashboard", { cookies: [sessionCookie(USER_A)] }),
        );

        expectSessionUnavailable(response);
      });
    },
  );
});

function expectSessionUnavailable(response: Response) {
  expect(response.status).toBe(503);
  expect(response.headers.get("location")).toBeNull();
  // Not forwarded to rendering, so no layout or page runs for this request.
  expect(response.headers.get("x-middleware-next")).toBeNull();
  expect(response.headers.get("x-middleware-rewrite")).toBeNull();
  expect(response.headers.get("Cache-Control")).toContain("no-store");
}

async function bodyWithoutReference(response: Response) {
  return (await response.text()).replace(/err_[0-9a-f]+/, "err_<reference>");
}

describe("credential rejection by the auth server", () => {
  describe.each([401, 403])("auth server status %i", (status) => {
    beforeEach(() => {
      installStubAuthServer({ mode: "status", status });
    });

    it("rejects requireSession with an AuthenticationError rather than a lookup failure", async () => {
      const result = await settle(requireSession());

      expect(result.outcome).toBe("rejected");
      if (result.outcome !== "rejected") {
        return;
      }
      expect(result.error).toBeInstanceOf(AuthenticationError);
      expect(result.error).not.toBeInstanceOf(SessionLookupError);
      expect(result.error).toMatchObject({ code: "session_invalid" });
    });

    it("redirects the dashboard layout to sign-in", async () => {
      await expectLayoutRedirectsToSignIn();
    });
  });
});

describe("proxy during an auth server network failure", () => {
  beforeEach(() => {
    installStubAuthServer({ mode: "network-failure" });
  });

  it("neither redirects a signed-in dashboard request to sign-in nor forwards it", async () => {
    const result = await settle(
      proxy(proxyRequest("/dashboard", { cookies: [sessionCookie(USER_A)] })),
    );

    expect(result.outcome).toBe("resolved");
    if (result.outcome !== "resolved") {
      return;
    }
    const response = result.value;
    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) {
      return;
    }
    expectSessionUnavailable(response);
  });

  it("answers existing and non-existent dashboard paths identically", async () => {
    const responses = await Promise.all(
      [
        "/dashboard/systems/0b6a2a4e-6f3c-4c1e-9d2a-2f6a1c9e8b11",
        "/dashboard/nope",
      ].map((path) =>
        proxy(proxyRequest(path, { cookies: [sessionCookie(USER_A)] })),
      ),
    );

    const [first, second] = await Promise.all(
      responses.map(async (response) => ({
        status: response.status,
        location: response.headers.get("location"),
        body: await bodyWithoutReference(response),
      })),
    );
    expect(first).toEqual(second);
  });

  it("gives the client a reference code and nothing about the failure", async () => {
    const cookie = sessionCookie(USER_A);
    const response = await proxy(
      proxyRequest("/dashboard", { cookies: [cookie] }),
    );

    const body = await response.text();
    expect(body).toMatch(/Reference: err_[0-9a-f]{12}/);
    for (const secret of [
      USER_A.accessToken,
      cookie.value,
      serverEnv().SUPABASE_URL,
      "fetch failed",
    ]) {
      expect(body).not.toContain(secret);
    }
  });

  it("still lets a non-dashboard request through", async () => {
    const response = await proxy(
      proxyRequest("/", { cookies: [sessionCookie(USER_A)] }),
    );

    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.get("location")).toBeNull();
  });

  it("still applies the content security policy and security headers", async () => {
    const response = await proxy(
      proxyRequest("/dashboard", { cookies: [sessionCookie(USER_A)] }),
    );

    const policy = response.headers.get("Content-Security-Policy");
    expect(policy).toMatch(/script-src [^;]*'nonce-[0-9a-f]+'/);
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Referrer-Policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(response.headers.get("Permissions-Policy")).toBe(
      "camera=(), microphone=(), geolocation=(), interest-cohort=()",
    );
    expect(response.headers.get("Strict-Transport-Security")).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );
  });
});

describe("client-induced lookup failure", () => {
  // supabase-js refuses to send a token that is not a valid header value, and
  // reports it as a retryable network error without contacting the auth server.
  // An attacker controls the cookie, so this must fail closed in the proxy.
  it.each([
    ["a newline", "token\nwith-newline"],
    ["a code point above 255", `token-${String.fromCharCode(256)}`],
  ])(
    "does not forward a dashboard request whose access token contains %s",
    async (_description, accessToken) => {
      const { requests } = installStubAuthServer({
        mode: "normal",
        users: [USER_A],
      });
      const cookie = sessionCookie({ ...USER_A, accessToken });

      const response = await proxy(
        proxyRequest("/dashboard/systems", { cookies: [cookie] }),
      );

      expectSessionUnavailable(response);
      expect(requests).toHaveLength(0);
    },
  );

  it("logs the failure class so operators can tell it from an outage, without the token", async () => {
    installStubAuthServer({ mode: "normal", users: [USER_A] });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const accessToken = "token\nwith-newline";

    const response = await proxy(
      proxyRequest("/dashboard", {
        cookies: [sessionCookie({ ...USER_A, accessToken })],
      }),
    );

    const reference = (await response.text()).match(/err_[0-9a-f]{12}/)?.[0];
    expect(warn).toHaveBeenCalledWith({
      event: "proxy_session_lookup_failed",
      code: "session_lookup_failed",
      reference,
      causeName: "AuthRetryableFetchError",
      causeStatus: 0,
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("with-newline");
  });
});

describe("SessionLookupError disclosure", () => {
  beforeEach(() => {
    installStubAuthServer({ mode: "network-failure" });
  });

  it("carries no token, cookie value, or auth server URL in its message or serialized form", async () => {
    const cookie = sessionCookie(USER_A);
    useRequestCookies([cookie]);

    const result = await settle(requireSession());

    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") {
      return;
    }
    const { error } = result;
    expect(error).toBeInstanceOf(SessionLookupError);
    if (!(error instanceof SessionLookupError)) {
      return;
    }

    const supabaseUrl = serverEnv().SUPABASE_URL;
    const forbidden = [
      USER_A.accessToken,
      USER_A.refreshToken,
      cookie.value,
      supabaseUrl,
      new URL(supabaseUrl).host,
    ];
    const renderings = [
      String(error),
      error.message,
      JSON.stringify({
        message: error.message,
        code: error.code,
        name: error.name,
      }),
      JSON.stringify(error),
    ];

    for (const rendering of renderings) {
      for (const secret of forbidden) {
        expect(rendering).not.toContain(secret);
      }
    }
  });
});

describe("malformed auth server success response", () => {
  function stubUserEndpoint(respond: () => Response) {
    const stubFetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const { pathname } = new URL(request.url);
        if (pathname === "/auth/v1/user" && request.method === "GET") {
          return respond();
        }
        return new Response(JSON.stringify({ code: "not_found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      },
    );
    vi.stubGlobal("fetch", stubFetch);
    return stubFetch;
  }

  function jsonResponse(body: unknown) {
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  it("rejects requireSession with a SessionLookupError when the user id is not a UUID", async () => {
    const stubFetch = stubUserEndpoint(() =>
      jsonResponse({
        id: "not-a-uuid",
        aud: "authenticated",
        role: "authenticated",
        email: "someone@example.test",
        app_metadata: { provider: "email" },
        user_metadata: {},
        created_at: "2026-01-01T00:00:00Z",
      }),
    );

    const result = await settle(requireSession());

    expect(stubFetch).toHaveBeenCalled();
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") {
      return;
    }
    expect(result.error).toBeInstanceOf(SessionLookupError);
    expect(result.error).toMatchObject({ code: "session_lookup_failed" });
  });

  it("rejects requireSession with a SessionLookupError when the user id is missing", async () => {
    stubUserEndpoint(() =>
      jsonResponse({ aud: "authenticated", role: "authenticated" }),
    );

    const result = await settle(requireSession());

    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") {
      return;
    }
    expect(result.error).toBeInstanceOf(SessionLookupError);
  });

  it("rejects requireSession with a SessionLookupError when the body is not JSON", async () => {
    stubUserEndpoint(
      () =>
        new Response("<html>gateway</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );

    const result = await settle(requireSession());

    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") {
      return;
    }
    expect(result.error).toBeInstanceOf(SessionLookupError);
  });

  it("fails the dashboard layout closed when the user id is not a UUID", async () => {
    stubUserEndpoint(() => jsonResponse({ id: "not-a-uuid" }));

    await expectLayoutFailsClosedWithLookupError();
  });
});
