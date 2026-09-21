import { NextRequest } from "next/server";
import { vi } from "vitest";

import { serverEnv } from "@/lib/env/server-env";

/**
 * A stand-in for the Supabase auth server, installed as `fetch`, so the real
 * `@supabase/ssr` and `supabase-js` code paths run — cookie decoding, expiry
 * detection, refresh, session removal — without a Supabase instance. CI has
 * none, and these suites run in CI.
 */

/**
 * An access token shaped like GoTrue's: a JWT whose payload carries the `amr`
 * claim the application reads for the session's age (TASK-003h). Unsigned —
 * the stub accepts it by exact match, as GoTrue accepts its own signature.
 */
export function stubAccessToken(
  subject: string,
  { signedInSecondsAgo = 60 * 60 }: { signedInSecondsAgo?: number } = {},
) {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const signedInAt = Math.floor(Date.now() / 1000) - signedInSecondsAgo;
  return [
    encode({ alg: "HS256", typ: "JWT" }),
    encode({ sub: subject, amr: [{ method: "otp", timestamp: signedInAt }] }),
    encode({ stub: subject }),
  ].join(".");
}

export const USER_A = {
  id: "0b6a2a4e-6f3c-4c1e-9d2a-2f6a1c9e8b11",
  accessToken: stubAccessToken("access-token-user-a"),
  refreshToken: "refresh-token-user-a",
} as const;

export const USER_B = {
  id: "7d1f0c3a-2b5e-4a8d-b6c9-4e3f2a1b0c22",
  accessToken: stubAccessToken("access-token-user-b"),
  refreshToken: "refresh-token-user-b",
} as const;

export type StubUser = {
  id: string;
  accessToken: string;
  refreshToken: string;
};

type AuthServerBehaviour =
  /** Validates tokens and serves refreshes for the users passed in. */
  | {
      mode: "normal";
      users: StubUser[];
      refreshedUsers?: StubUser[];
      /** Answer to `POST /otp` (magic-link request). Defaults to success. */
      otp?: { status: number; code?: string };
      /**
       * Single-use PKCE auth codes and the user each signs in. A second
       * exchange of the same code fails, as GoTrue's does.
       */
      pkceCodes?: Record<string, StubUser>;
      /** Auth codes whose flow state has expired. */
      expiredPkceCodes?: string[];
    }
  /** The auth server is unreachable. */
  | { mode: "network-failure" }
  /** The auth server answers, but with the given status for every request. */
  | { mode: "status"; status: number }
  /**
   * The session was revoked server-side (signed out elsewhere): GoTrue answers
   * `/user` with 403 `session_not_found` on a versioned API response, which
   * auth-js maps to AuthSessionMissingError and clears the session.
   */
  | { mode: "revoked" }
  /**
   * The session is past its absolute or idle limit (TASK-003e). GoTrue answers
   * `/user` with 403 and a refresh with 400, both `session_expired`.
   */
  | { mode: "session-expired" };

export type RecordedAuthRequest = {
  method: string;
  path: string;
  authorization: string | null;
};

/**
 * A call to the application's rate-limit function (TASK-003c). Recorded apart
 * from auth requests, so "no Supabase Auth call" assertions stay exact.
 */
export type RecordedRateLimitCall = {
  key: string;
  limit: number;
  windowSeconds: number;
  minIntervalSeconds: number;
  apikey: string | null;
};

/**
 * How the stub database answers the rate-limit function. Defaults to allowing
 * every hit, so tests about other behaviour are unaffected.
 */
export type RateLimitBehaviour =
  "allow" | "unavailable" | ((call: RecordedRateLimitCall) => boolean);

/** Parsed JSON bodies, recorded separately so request assertions stay exact. */
export type RecordedAuthBody = { path: string; body: unknown };

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
export function installStubAuthServer(
  behaviour: AuthServerBehaviour,
  { rateLimit = "allow" }: { rateLimit?: RateLimitBehaviour } = {},
) {
  const rateLimitCalls: RecordedRateLimitCall[] = [];
  const requests: RecordedAuthRequest[] = [];
  const bodies: RecordedAuthBody[] = [];
  const usedPkceCodes = new Set<string>();

  const stubFetch = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      const path = `${url.pathname}${url.search}`;

      if (url.pathname === "/rest/v1/rpc/consume_rate_limit") {
        const body = (await request.json()) as Record<string, unknown>;
        const call: RecordedRateLimitCall = {
          key: String(body.p_key),
          limit: Number(body.p_limit),
          windowSeconds: Number(body.p_window_seconds),
          minIntervalSeconds: Number(body.p_min_interval_seconds),
          apikey: request.headers.get("apikey"),
        };
        rateLimitCalls.push(call);
        if (rateLimit === "unavailable") {
          return json({ message: "stubbed database outage" }, 503);
        }
        return json(rateLimit === "allow" ? true : rateLimit(call), 200);
      }

      requests.push({
        method: request.method,
        path,
        authorization: request.headers.get("authorization"),
      });
      const bodyText = await request.clone().text();
      if (bodyText) {
        bodies.push({ path, body: parseJson(bodyText) });
      }

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

      if (behaviour.mode === "session-expired") {
        const refreshing = url.pathname === "/auth/v1/token";
        return json(
          {
            code: "session_expired",
            msg: refreshing
              ? "Invalid Refresh Token: Session Expired"
              : "Session is no longer valid",
          },
          refreshing ? 400 : 403,
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

      if (url.pathname === "/auth/v1/otp" && request.method === "POST") {
        const otp = behaviour.otp ?? { status: 200 };
        return otp.status === 200
          ? json({}, 200)
          : json(
              { code: otp.code ?? "unexpected_failure", msg: "stubbed" },
              otp.status,
            );
      }

      if (
        url.pathname === "/auth/v1/token" &&
        url.searchParams.get("grant_type") === "pkce"
      ) {
        const body = parseJson(bodyText) as { auth_code?: string };
        const authCode = body.auth_code ?? "";
        if (behaviour.expiredPkceCodes?.includes(authCode)) {
          return json({ code: "flow_state_expired", msg: "expired" }, 403);
        }
        const user = behaviour.pkceCodes?.[authCode];
        if (!user || usedPkceCodes.has(authCode)) {
          return json({ code: "flow_state_not_found", msg: "not found" }, 404);
        }
        usedPkceCodes.add(authCode);
        return json(
          {
            access_token: user.accessToken,
            refresh_token: user.refreshToken,
            token_type: "bearer",
            expires_in: 3600,
            expires_at: secondsFromNow(3600),
            user: userResponse(user),
          },
          200,
        );
      }

      if (url.pathname === "/auth/v1/logout" && request.method === "POST") {
        return new Response(null, { status: 204 });
      }

      return json({ code: "not_found", msg: "no stub for this route" }, 404);
    },
  );

  vi.stubGlobal("fetch", stubFetch);

  return { requests, bodies, rateLimitCalls };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
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
