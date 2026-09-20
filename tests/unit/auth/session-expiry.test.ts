import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  sessionCookieName,
  sessionRefreshState,
} from "@/lib/auth/session-expiry";

const NOW = 1_800_000_000;

function store(cookies: Record<string, string>) {
  return {
    getAll: () =>
      Object.entries(cookies).map(([name, value]) => ({ name, value })),
  };
}

function encoded(session: unknown) {
  return `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
}

function sessionCookie(expiresAt: number) {
  return { [sessionCookieName()]: encoded({ expires_at: expiresAt }) };
}

describe("sessionRefreshState", () => {
  it("reports no session when there is no cookie", () => {
    expect(sessionRefreshState(store({}), NOW)).toBe("none");
  });

  it("ignores cookies that only share the prefix, such as PKCE verifiers", () => {
    const name = sessionCookieName();
    expect(
      sessionRefreshState(
        store({
          [`${name}-code-verifier`]: "verifier",
          [`${name}-flow-abc-code-verifier`]: "verifier",
          [`${name}-flows-code-verifier`]: "[]",
        }),
        NOW,
      ),
    ).toBe("none");
  });

  it("reports a valid session while its access token has not expired", () => {
    expect(sessionRefreshState(store(sessionCookie(NOW + 60)), NOW)).toBe(
      "valid",
    );
  });

  it.each([
    ["expired a minute ago", NOW - 60],
    ["expiring exactly now", NOW],
  ])("reports a refresh for a session %s", (_label, expiresAt) => {
    expect(sessionRefreshState(store(sessionCookie(expiresAt)), NOW)).toBe(
      "refresh",
    );
  });

  it("reassembles a chunked session cookie", () => {
    const name = sessionCookieName();
    const value = encoded({ expires_at: NOW + 60 });
    const half = Math.ceil(value.length / 2);

    expect(
      sessionRefreshState(
        store({
          [`${name}.1`]: value.slice(half),
          [`${name}.0`]: value.slice(0, half),
        }),
        NOW,
      ),
    ).toBe("valid");
  });

  it.each([
    ["a value that is not base64", "base64-!!!"],
    [
      "a payload that is not JSON",
      `base64-${Buffer.from("{oops").toString("base64url")}`,
    ],
    ["JSON that is not a session", encoded({ hello: "world" })],
    ["a text expiry", encoded({ expires_at: "soon" })],
    ["an empty value", ""],
  ])("treats %s as needing a refresh, the costly case", (_label, value) => {
    expect(
      sessionRefreshState(store({ [sessionCookieName()]: value }), NOW),
    ).toBe("refresh");
  });
});
