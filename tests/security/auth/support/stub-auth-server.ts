import { NextRequest } from "next/server";
import { vi } from "vitest";

import { serverEnv } from "@/lib/env/server-env";

/**
 * A stand-in for the Supabase auth server, installed as `fetch`, so the real
 * `@supabase/ssr` and `supabase-js` code paths run — cookie decoding, expiry
 * detection, refresh, session removal — without a Supabase instance. CI has
 * none, and these suites run in CI.
 */

export const USER_A = {
  id: "0b6a2a4e-6f3c-4c1e-9d2a-2f6a1c9e8b11",
  accessToken: "access-token-user-a",
  refreshToken: "refresh-token-user-a",
} as const;

export const USER_B = {
  id: "7d1f0c3a-2b5e-4a8d-b6c9-4e3f2a1b0c22",
  accessToken: "access-token-user-b",
  refreshToken: "refresh-token-user-b",
} as const;

export type StubUser = {
  id: string;
  accessToken: string;
  refreshToken: string;
};

type AuthServerBehaviour =
  /** Validates tokens and serves refreshes for the users passed in. */
  | { mode: "normal"; users: StubUser[]; refreshedUsers?: StubUser[] }
  /** The auth server is unreachable. */
  | { mode: "network-failure" }
  /** The auth server answers, but with the given status for every request. */
  | { mode: "status"; status: number }
  /**
   * The session was revoked server-side (signed out elsewhere): GoTrue answers
   * `/user` with 403 `session_not_found` on a versioned API response, which
   * auth-js maps to AuthSessionMissingError and clears the session.
   */
  | { mode: "revoked" };

export type RecordedAuthRequest = {
  method: string;
  path: string;
  authorization: string | null;
};

/** Mirrors supabase-js: `sb-<first hostname label>-auth-token`. */
export function sessionCookieName() {
  const { hostname } = new URL(serverEnv().SUPABASE_URL);
  return `sb-${hostname.split(".")[0]}-auth-token`;
}

function userResponse(user: StubUser) {
  return {
    id: user.id,
    aud: "authenticated",
    role: "authenticated",
    email: `${user.id}@example.test`,
    app_metadata: { provider: "email" },
    user_metadata: {},
    created_at: "2026-01-01T00:00:00Z",
  };
}

function secondsFromNow(seconds: number) {
  return Math.floor(Date.now() / 1000) + seconds;
}

/**
 * Encodes a session the way `@supabase/ssr` writes it: `base64-` plus the
 * base64url JSON. `expiresInSeconds` may be negative to model an expired
 * access token.
 */
export function sessionCookie(
  user: StubUser,
  { expiresInSeconds = 3600 }: { expiresInSeconds?: number } = {},
) {
  const session = {
    access_token: user.accessToken,
    refresh_token: user.refreshToken,
    token_type: "bearer",
    expires_in: Math.max(expiresInSeconds, 0),
    expires_at: secondsFromNow(expiresInSeconds),
    user: userResponse(user),
  };

  return {
    name: sessionCookieName(),
    value: `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`,
  };
}

function json(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    // auth-js reads the error `code` only from responses declaring an API
    // version, as GoTrue does; without it every error would lose its code.
    headers: {
      "content-type": "application/json",
      "x-supabase-api-version": "2024-01-01",
    },
  });
}

/**
 * Installs the stub as the global `fetch` and returns the log of requests it
 * received. Call `vi.unstubAllGlobals()` in `afterEach`.
 */
export function installStubAuthServer(behaviour: AuthServerBehaviour) {
  const requests: RecordedAuthRequest[] = [];

  const stubFetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        path: `${url.pathname}${url.search}`,
        authorization: request.headers.get("authorization"),
      });

      if (behaviour.mode === "network-failure") {
        throw new TypeError("fetch failed");
      }
      if (behaviour.mode === "status") {
        return json(
          { code: "unexpected_failure", msg: "stubbed failure" },
          behaviour.status,
        );
      }
      if (behaviour.mode === "revoked") {
        return json(
          {
            code: "session_not_found",
            msg: "Session from session_id claim in JWT does not exist",
          },
          403,
        );
      }

      if (url.pathname === "/auth/v1/user" && request.method === "GET") {
        const token = request.headers
          .get("authorization")
          ?.replace(/^Bearer /, "");
        const user = [
          ...behaviour.users,
          ...(behaviour.refreshedUsers ?? []),
        ].find((candidate) => candidate.accessToken === token);
        return user
          ? json(userResponse(user), 200)
          : json({ code: "bad_jwt", msg: "invalid JWT" }, 403);
      }

      if (
        url.pathname === "/auth/v1/token" &&
        url.searchParams.get("grant_type") === "refresh_token"
      ) {
        const body = (await request.json()) as { refresh_token?: string };
        const index = behaviour.users.findIndex(
          (candidate) => candidate.refreshToken === body.refresh_token,
        );
        const refreshed = behaviour.refreshedUsers?.[index];
        if (index === -1 || !refreshed) {
          return json(
            {
              code: "refresh_token_not_found",
              msg: "Invalid Refresh Token: Refresh Token Not Found",
            },
            400,
          );
        }
        return json(
          {
            access_token: refreshed.accessToken,
            refresh_token: refreshed.refreshToken,
            token_type: "bearer",
            expires_in: 3600,
            expires_at: secondsFromNow(3600),
            user: userResponse(refreshed),
          },
          200,
        );
      }

      return json({ code: "not_found", msg: "no stub for this route" }, 404);
    },
  );

  vi.stubGlobal("fetch", stubFetch);

  return { requests };
}

export function proxyRequest(
  path: string,
  {
    cookies = [],
    headers = {},
    method = "GET",
    body,
  }: {
    cookies?: { name: string; value: string }[];
    headers?: Record<string, string>;
    method?: string;
    body?: string;
  } = {},
) {
  const cookieHeader = cookies
    .map(({ name, value }) => `${name}=${value}`)
    .join("; ");

  // Concatenated rather than resolved against a base: `new URL("//dashboard",
  // base)` would read the path as protocol-relative and discard it.
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: cookieHeader ? { ...headers, cookie: cookieHeader } : headers,
    ...(body === undefined ? {} : { body }),
  });
}

/**
 * A `next/headers` cookie store over a fixed set of cookies, for exercising
 * `requireSession()` outside a Next.js request. Writes are recorded, not
 * applied, as in a server component.
 */
export function headersCookieStore(cookies: { name: string; value: string }[]) {
  return {
    getAll: () => cookies.map(({ name, value }) => ({ name, value })),
    get: (name: string) => cookies.find((cookie) => cookie.name === name),
    set: vi.fn(),
  };
}
