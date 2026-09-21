import { createChunks, stringToBase64URL } from "@supabase/ssr";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  AUTH_JS_EXPIRY_MARGIN_MS,
  sessionCookieName,
  sessionRefreshState,
} from "@/lib/auth/session-expiry";

const NOW_MS = 1_800_000_000_000;
const NOW = NOW_MS / 1000;

function store(cookies: Record<string, string>) {
  return {
    getAll: () =>
      Object.entries(cookies).map(([name, value]) => ({ name, value })),
  };
}

/** Encoded exactly as `@supabase/ssr` writes it. */
function encoded(session: unknown) {
  return `base64-${stringToBase64URL(JSON.stringify(session))}`;
}

function session(expiresAt: unknown) {
  return {
    access_token: "access",
    refresh_token: "refresh",
    expires_at: expiresAt,
  };
}

function cookieFor(value: unknown) {
  return { [sessionCookieName()]: encoded(value) };
}

describe("sessionRefreshState: agreeing with auth-js on when it refreshes", () => {
  it("uses auth-js's 90-second margin", () => {
    expect(AUTH_JS_EXPIRY_MARGIN_MS).toBe(90_000);
  });

  it("reports no session when there is no cookie", async () => {
    await expect(sessionRefreshState(store({}), NOW_MS)).resolves.toBe("none");
  });

  it("reports a valid session outside the margin", async () => {
    await expect(
      sessionRefreshState(store(cookieFor(session(NOW + 91))), NOW_MS),
    ).resolves.toBe("valid");
  });

  it.each([
    ["expired a minute ago", NOW - 60],
    ["expiring exactly now", NOW],
    // auth-js refreshes these too; treating them as valid let a crafted
    // near-expiry cookie refresh without spending any allowance.
    ["expiring in 60 seconds, inside the margin", NOW + 60],
    ["expiring in 89 seconds", NOW + 89],
  ])("reports a refresh for a session %s", async (_label, expiresAt) => {
    await expect(
      sessionRefreshState(store(cookieFor(session(expiresAt))), NOW_MS),
    ).resolves.toBe("refresh");
  });

  it("treats a missing expiry as not expired, as auth-js does", async () => {
    await expect(
      sessionRefreshState(store(cookieFor(session(0))), NOW_MS),
    ).resolves.toBe("valid");
  });

  it.each([
    ["no access token", { refresh_token: "r", expires_at: NOW - 60 }],
    ["no refresh token", { access_token: "a", expires_at: NOW - 60 }],
    ["no expiry", { access_token: "a", refresh_token: "r" }],
    ["an array", [1, 2, 3]],
    ["a string", "session"],
  ])(
    "reports no session for JSON auth-js would not accept: %s",
    async (_label, value) => {
      await expect(
        sessionRefreshState(store(cookieFor(value)), NOW_MS),
      ).resolves.toBe("none");
    },
  );
});

describe("sessionRefreshState: reading the cookie as @supabase/ssr does", () => {
  it("reassembles chunks written by @supabase/ssr", async () => {
    const name = sessionCookieName();
    const chunks = createChunks(name, encoded(session(NOW - 60)), 40);
    expect(chunks.length).toBeGreaterThan(1);

    await expect(
      sessionRefreshState(
        store(Object.fromEntries(chunks.map((c) => [c.name, c.value]))),
        NOW_MS,
      ),
    ).resolves.toBe("refresh");
  });

  it("falls back to the chunks when the whole cookie is empty", async () => {
    // @supabase/ssr ignores an empty whole cookie and reads the chunks; so
    // does auth-js, and so it refreshes. Reading the empty value as "no
    // session" let this skip the limit.
    const name = sessionCookieName();
    const chunks = createChunks(name, encoded(session(NOW - 60)), 40);

    await expect(
      sessionRefreshState(
        store({
          [name]: "",
          ...Object.fromEntries(chunks.map((c) => [c.name, c.value])),
        }),
        NOW_MS,
      ),
    ).resolves.toBe("refresh");
  });

  it("stops at the first missing chunk index, as @supabase/ssr does", async () => {
    const name = sessionCookieName();
    const chunks = createChunks(name, encoded(session(NOW - 60)), 40);
    const withGap = Object.fromEntries(
      chunks.filter((_c, index) => index !== 1).map((c) => [c.name, c.value]),
    );

    // Only chunk 0 is read, which is not a whole session.
    await expect(sessionRefreshState(store(withGap), NOW_MS)).resolves.toBe(
      "none",
    );
  });

  it("ignores cookies that only share the prefix, such as PKCE verifiers", async () => {
    const name = sessionCookieName();
    await expect(
      sessionRefreshState(
        store({
          [`${name}-code-verifier`]: "verifier",
          [`${name}-flow-abc-code-verifier`]: "verifier",
        }),
        NOW_MS,
      ),
    ).resolves.toBe("none");
  });

  it.each([
    // stringFromBase64URL rejects these; a lenient decoder might not.
    ["characters outside base64url", "base64-!!!"],
    ["a payload that is not JSON", `base64-${stringToBase64URL("{oops")}`],
    ["an empty value", ""],
  ])("reports no session for %s", async (_label, value) => {
    await expect(
      sessionRefreshState(store({ [sessionCookieName()]: value }), NOW_MS),
    ).resolves.toBe("none");
  });

  it("reads a plain JSON value without the base64 prefix, as @supabase/ssr does", async () => {
    await expect(
      sessionRefreshState(
        store({ [sessionCookieName()]: JSON.stringify(session(NOW - 60)) }),
        NOW_MS,
      ),
    ).resolves.toBe("refresh");
  });
});
