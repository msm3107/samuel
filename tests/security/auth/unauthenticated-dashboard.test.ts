import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The sign-in path now reaches the rate limiter, a server-only module.
vi.mock("server-only", () => ({}));

/**
 * The cookies `next/headers` hands to server components in the layout tests.
 * The factory returns the harness store directly, so no cast to Next's cookie
 * type is needed.
 */
const headerCookies = vi.hoisted(() => ({
  current: [] as { name: string; value: string }[],
}));

vi.mock("next/headers", async () => {
  const { headersCookieStore } = await import("./support/stub-auth-server");
  return {
    cookies: vi.fn(async () => headersCookieStore(headerCookies.current)),
  };
});

import DashboardPage from "@/app/(dashboard)/dashboard/page";
import DashboardLayout from "@/app/(dashboard)/layout";
import { isDashboardPath, SIGN_IN_PATH } from "@/lib/auth/protected-routes";
import proxy from "@/proxy";

import {
  installStubAuthServer,
  proxyRequest,
} from "./support/stub-auth-server";

const APP_ORIGIN = "http://localhost:3000";
const SIGN_IN_URL = `${APP_ORIGIN}/sign-in`;
// 303, so a POST whose session expired is followed by a GET to sign-in.
const SEE_OTHER = 303;

/**
 * Builds a request from an absolute URL. `proxyRequest` resolves its path
 * against a base URL, which turns `//dashboard` into a protocol-relative URL
 * for a host named "dashboard"; this keeps the raw path intact.
 */
function rawPathRequest(rawPath: string) {
  return new NextRequest(`${APP_ORIGIN}${rawPath}`);
}

/** Everything a client can observe about a response, with the nonce masked. */
async function observableResponse(response: Response) {
  const headers = [...response.headers.entries()]
    .map(([name, value]) =>
      name === "content-security-policy"
        ? [name, value.replace(/'nonce-[^']+'/, "'nonce-<masked>'")]
        : [name, value],
    )
    .sort(([a = ""], [b = ""]) => a.localeCompare(b));

  return {
    status: response.status,
    location: response.headers.get("location"),
    body: await response.text(),
    headers,
  };
}

function redirectDigest(error: unknown) {
  if (
    error instanceof Error &&
    "digest" in error &&
    typeof error.digest === "string"
  ) {
    return error.digest;
  }
  return undefined;
}

let authRequests: ReturnType<typeof installStubAuthServer>["requests"];

beforeEach(() => {
  headerCookies.current = [];
  ({ requests: authRequests } = installStubAuthServer({
    mode: "normal",
    users: [],
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("security: unauthenticated dashboard request redirects and reveals nothing", () => {
  describe("proxy", () => {
    it("redirects an unauthenticated dashboard request to sign-in", async () => {
      const response = await proxy(proxyRequest("/dashboard"));

      expect(response.status).toBe(SEE_OTHER);
      expect(response.headers.get("location")).toBe(SIGN_IN_URL);
    });

    it("makes no auth server call when the request carries no session cookie", async () => {
      await proxy(proxyRequest("/dashboard"));

      expect(authRequests).toEqual([]);
    });

    it("gives an identical redirect whether or not the requested dashboard resource exists", async () => {
      const paths = [
        "/dashboard",
        "/dashboard/systems/3f2b8c1d-9a4e-4b7f-8c2d-1e6a5b9f0c33",
        "/dashboard/does-not-exist",
        "/dashboard?userId=x&next=https://evil.example",
      ];

      const observed = await Promise.all(
        paths.map(async (path) =>
          observableResponse(await proxy(proxyRequest(path))),
        ),
      );

      const [first, ...rest] = observed;
      expect(first?.status).toBe(SEE_OTHER);
      expect(first?.location).toBe(SIGN_IN_URL);
      for (const other of rest) {
        expect(other).toEqual(first);
      }
    });

    it("carries no trace of the requested path, query, or an external origin in the redirect", async () => {
      const response = await proxy(
        proxyRequest(
          "/dashboard/systems/3f2b8c1d-9a4e-4b7f-8c2d-1e6a5b9f0c33?userId=x&next=https://evil.example",
        ),
      );
      const location = response.headers.get("location") ?? "";
      const body = await response.text();

      expect(new URL(location).origin).toBe(APP_ORIGIN);
      expect(new URL(location).pathname).toBe(SIGN_IN_PATH);
      expect(new URL(location).search).toBe("");
      for (const fragment of [
        "dashboard",
        "systems",
        "3f2b8c1d",
        "userId",
        "next",
        "evil",
      ]) {
        expect(location).not.toContain(fragment);
        expect(body).not.toContain(fragment);
      }
    });

    it("builds the redirect origin from configuration, not a spoofed Host header", async () => {
      const request = proxyRequest("/dashboard", {
        headers: {
          host: "evil.example",
          "x-forwarded-host": "evil.example",
          "x-forwarded-proto": "https",
        },
      });
      // Guards against the spoof being silently dropped, which would make this
      // test pass without exercising anything.
      expect(request.headers.get("host")).toBe("evil.example");
      expect(request.headers.get("x-forwarded-host")).toBe("evil.example");

      const response = await proxy(request);

      expect(response.status).toBe(SEE_OTHER);
      expect(response.headers.get("location")).toBe(SIGN_IN_URL);
    });

    it("keeps the security headers on the redirect and forbids caching it", async () => {
      const response = await proxy(proxyRequest("/dashboard"));

      expect(response.status).toBe(SEE_OTHER);
      expect(response.headers.get("content-security-policy")).toMatch(
        /script-src [^;]*'nonce-[A-Za-z0-9]+'/,
      );
      expect(response.headers.get("content-security-policy")).toContain(
        "frame-ancestors 'none'",
      );
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe(
        "strict-origin-when-cross-origin",
      );
      expect(response.headers.get("permissions-policy")).toContain("camera=()");
      expect(response.headers.get("cache-control")).toContain("no-store");
    });

    it("redirects an unauthenticated segment prefetch of the dashboard", async () => {
      const response = await proxy(
        proxyRequest("/dashboard.segments/_tree.segment", {
          headers: { rsc: "1", "next-router-prefetch": "1" },
        }),
      );

      expect(response.status).toBe(SEE_OTHER);
      expect(response.headers.get("x-middleware-next")).toBeNull();
    });

    it("does not forward the request to rendering when redirecting", async () => {
      const response = await proxy(proxyRequest("/dashboard"));

      expect(response.headers.get("x-middleware-next")).toBeNull();
      expect(response.headers.get("x-middleware-rewrite")).toBeNull();
    });

    it.each(["/", "/sign-in", "/dashboards", "/dashboard-settings"])(
      "lets an unauthenticated request to the non-dashboard path %s through",
      async (path) => {
        const response = await proxy(proxyRequest(path));

        expect(response.status).toBe(200);
        expect(response.headers.get("location")).toBeNull();
        expect(response.headers.get("x-middleware-next")).toBe("1");
      },
    );

    it.each([
      "/Dashboard",
      "/DASHBOARD/x",
      "//dashboard",
      "/%64ashboard",
      "/dashboard/",
    ])(
      "redirects the alternate dashboard spelling %s to sign-in",
      async (rawPath) => {
        const request = rawPathRequest(rawPath);
        expect(request.nextUrl.origin).toBe(APP_ORIGIN);
        expect(request.nextUrl.pathname).toBe(rawPath);

        const response = await proxy(request);

        expect(response.status).toBe(SEE_OTHER);
        expect(response.headers.get("location")).toBe(SIGN_IN_URL);
      },
    );

    it("fails closed and redirects a dashboard path with malformed percent-encoding", async () => {
      const request = rawPathRequest("/dashboard%E0%A4%A");
      expect(request.nextUrl.pathname).toBe("/dashboard%E0%A4%A");

      const response = await proxy(request);

      expect(response.status).toBe(SEE_OTHER);
      expect(response.headers.get("location")).toBe(SIGN_IN_URL);
    });
  });

  describe("dashboard layout", () => {
    it("redirects to sign-in and never renders its children without a session", async () => {
      let rendered: unknown = "layout did not resolve";
      let thrown: unknown;
      try {
        rendered = await DashboardLayout({ children: "secret" });
      } catch (error) {
        thrown = error;
      }

      expect(rendered).not.toBe("secret");
      const digest = redirectDigest(thrown);
      expect(digest).toMatch(/^NEXT_REDIRECT/);
      expect(digest).toContain(SIGN_IN_PATH);
    });

    it("carries no trace of the requested resource in the layout redirect", async () => {
      let thrown: unknown;
      try {
        await DashboardLayout({ children: "secret" });
      } catch (error) {
        thrown = error;
      }

      const digest = redirectDigest(thrown) ?? "";
      expect(digest).not.toContain("dashboard");
      expect(digest).not.toContain("secret");
      expect(digest).not.toContain("http");
    });

    it("makes no auth server call when the cookie store is empty", async () => {
      await DashboardLayout({ children: "secret" }).catch(() => undefined);

      expect(authRequests).toEqual([]);
    });
  });

  describe("dashboard page", () => {
    // Next.js can render a page without re-running its layout, so the page
    // must refuse on its own even if the layout check never ran.
    it("redirects to sign-in by itself, without relying on the layout", async () => {
      let rendered: unknown = "page did not resolve";
      let thrown: unknown;
      try {
        rendered = await DashboardPage();
      } catch (error) {
        thrown = error;
      }

      expect(rendered).toBe("page did not resolve");
      const digest = redirectDigest(thrown);
      expect(digest).toMatch(/^NEXT_REDIRECT/);
      expect(digest).toContain(SIGN_IN_PATH);
    });
  });

  describe("isDashboardPath", () => {
    it.each([
      "/dashboard",
      "/dashboard/",
      "/dashboard/systems/3f2b8c1d-9a4e-4b7f-8c2d-1e6a5b9f0c33",
      "/Dashboard",
      "/DASHBOARD/x",
      "//dashboard",
      "///dashboard//systems",
      "/%64ashboard",
      "/%2Fdashboard",
      "/dashboard%2Fsystems",
      "/dashboard%E0%A4%A",
      "/%",
      // App Router transport forms, as the proxy receives them.
      "/dashboard.rsc",
      "/dashboard.segments/_tree.segment",
      "/dashboard.segments/_tree.segment.rsc",
      "/DASHBOARD.segments/$c$children.segment",
    ])("treats %s as protected", (pathname) => {
      expect(isDashboardPath(pathname)).toBe(true);
    });

    it.each([
      "/",
      "/sign-in",
      "/dashboards",
      "/dashboard-settings",
      "/dashboard_old",
      "/public/dashboard",
      "/public/dashboard.segments/_tree.segment",
      "/widget",
    ])("treats %s as public", (pathname) => {
      expect(isDashboardPath(pathname)).toBe(false);
    });
  });
});
