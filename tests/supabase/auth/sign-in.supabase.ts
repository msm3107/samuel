import { randomUUID } from "node:crypto";

import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  cookiesOf,
  readSession,
  sessionCookieName,
  writeSession,
} from "@/tests/supabase/support/session-cookies";
import { waitForMagicLink } from "@/tests/supabase/support/mailpit";

/**
 * Sign-in against the real local Supabase: GoTrue sends a real email to
 * Mailpit, the test follows the link it contains, and the real callback route
 * exchanges the code. Nothing here is stubbed except the Next.js cookie store,
 * which a route handler would otherwise get from the incoming request.
 */

const jar = vi.hoisted(() => new Map<string, string>());

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string, options?: { maxAge?: number }) => {
      if (value === "" || options?.maxAge === 0) {
        jar.delete(name);
      } else {
        jar.set(name, value);
      }
    },
  }),
}));

import { GET as callback } from "@/app/(auth)/auth/callback/route";
import { AuthenticationError } from "@/lib/auth/errors";
import { requireSession } from "@/lib/auth/require-session";
import { requestMagicLink } from "@/lib/auth/sign-in/request-magic-link";
import { signOut } from "@/lib/auth/sign-in/sign-out";
import { startGoogleSignIn } from "@/lib/auth/sign-in/start-google-sign-in";
import { createServiceRoleClient } from "@/lib/database/service-role-client";
import { serverEnv } from "@/lib/env/server-env";
import proxy from "@/proxy";

afterEach(() => {
  jar.clear();
});

function freshAddress() {
  return `sign-in-${randomUUID()}@example.test`;
}

/** Follows the email's verify link the way a browser would, one hop. */
async function openVerifyLink(link: string) {
  const response = await fetch(link, { redirect: "manual" });
  const location = response.headers.get("location");
  if (!location) {
    throw new Error(`Verify link did not redirect (status ${response.status})`);
  }
  return location;
}

async function signInThroughMailbox(address: string) {
  await expect(requestMagicLink(address)).resolves.toBe("link_sent");
  const link = await waitForMagicLink(address);
  const callbackLocation = await openVerifyLink(link);
  const response = await callback(new NextRequest(callbackLocation));
  return { link, callbackLocation, response };
}

async function userIdFor(address: string) {
  const admin = createServiceRoleClient();
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
  if (error) {
    throw error;
  }
  return data.users.find((user) => user.email === address)?.id;
}

describe("sign-in against local Supabase", () => {
  it("completes a magic-link sign-in: real email, real callback, real session", async () => {
    const address = freshAddress();

    const { callbackLocation, response } = await signInThroughMailbox(address);

    // GoTrue honoured the exact redirect allowlist and sent the browser to
    // this application's callback with a PKCE code.
    const callbackUrl = new URL(callbackLocation);
    expect(`${callbackUrl.origin}${callbackUrl.pathname}`).toBe(
      `${serverEnv().NEXT_PUBLIC_APP_URL}/auth/callback`,
    );
    expect(callbackUrl.searchParams.get("code")).toBeTruthy();

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      `${serverEnv().NEXT_PUBLIC_APP_URL}/dashboard`,
    );

    const expectedUserId = await userIdFor(address);
    expect(expectedUserId).toBeTruthy();
    await expect(requireSession()).resolves.toEqual({
      userId: expectedUserId,
    });
  });

  it("refuses a magic link opened a second time", async () => {
    const address = freshAddress();
    const { link } = await signInThroughMailbox(address);
    jar.clear();

    // The same email link again, as if forwarded or replayed. GoTrue itself
    // must refuse it: no new code, only an error. (Checking the callback alone
    // would pass even if GoTrue issued a fresh code, because the cleared jar
    // has no verifier either.)
    const secondLocation = new URL(await openVerifyLink(link));
    expect(secondLocation.searchParams.get("code")).toBeNull();
    expect(
      secondLocation.searchParams.get("error") ??
        new URLSearchParams(secondLocation.hash.slice(1)).get("error"),
    ).toBeTruthy();

    // And the application turns that into a refusal, not a session.
    const response = await callback(new NextRequest(secondLocation));
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.pathname).toBe("/sign-in");
    expect(location.searchParams.get("error")).toMatch(
      /^(link_expired|link_invalid|sign_in_failed)$/,
    );
    await expect(requireSession()).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("keeps a pending magic link working after a Google sign-in is started and abandoned", async () => {
    // Codex review of PR #6, finding F1. Every flow used to share one PKCE
    // verifier slot, so starting another sign-in overwrote the verifier a
    // pending link needed. Per-flow ids give each flow its own.
    const address = freshAddress();
    await expect(requestMagicLink(address)).resolves.toBe("link_sent");
    const link = await waitForMagicLink(address);

    // The person clicks "Continue with Google", then backs out.
    const google = await startGoogleSignIn();
    expect(google.status).toBe("redirect");

    const callbackLocation = await openVerifyLink(link);
    expect(new URL(callbackLocation).searchParams.get("sb_flow_id")).toMatch(
      /^[0-9a-f]{32}$/,
    );
    const response = await callback(new NextRequest(callbackLocation));

    expect(response.headers.get("location")).toBe(
      `${serverEnv().NEXT_PUBLIC_APP_URL}/dashboard`,
    );
    await expect(requireSession()).resolves.toEqual({
      userId: await userIdFor(address),
    });
  });

  it("rejects the old cookies after signing out through the application", async () => {
    // Codex review of PR #6, finding F6: revocation had only been tested by
    // calling GoTrue directly, never through the app's own sign-out.
    await signInThroughMailbox(freshAddress());
    const staleCopy = new Map(jar);

    await signOut();
    expect(() => readSession(jar)).toThrow();

    jar.clear();
    for (const [name, value] of staleCopy) {
      jar.set(name, value);
    }
    await expect(requireSession()).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("rejects a session that was revoked on the auth server", async () => {
    await signInThroughMailbox(freshAddress());
    const session = readSession(jar);
    const staleCopy = new Map(jar);

    // Sign out everywhere, as a person would from another device.
    const logout = await fetch(
      `${serverEnv().SUPABASE_URL}/auth/v1/logout?scope=global`,
      {
        method: "POST",
        headers: {
          apikey: serverEnv().SUPABASE_ANON_KEY,
          authorization: `Bearer ${session.access_token}`,
        },
      },
    );
    expect(logout.status).toBe(204);

    // The browser still holds the old, unexpired access token.
    jar.clear();
    for (const [name, value] of staleCopy) {
      jar.set(name, value);
    }
    await expect(requireSession()).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("refreshes an expired access token in the proxy and lets the dashboard through", async () => {
    await signInThroughMailbox(freshAddress());
    const session = readSession(jar);

    // Age the access token while keeping the real refresh token.
    writeSession(jar, {
      ...session,
      expires_at: Math.floor(Date.now() / 1000) - 60,
    });
    const cookieHeader = cookiesOf(jar)
      .map(({ name, value }) => `${name}=${value}`)
      .join("; ");

    const response = await proxy(
      new NextRequest(`${serverEnv().NEXT_PUBLIC_APP_URL}/dashboard`, {
        headers: { cookie: cookieHeader },
      }),
    );

    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("x-middleware-next")).toBe("1");

    // A new session was written back, HttpOnly, and is what rendering sees.
    const refreshed = response.headers
      .getSetCookie()
      .filter((cookie) => cookie.startsWith(sessionCookieName()));
    expect(refreshed.length).toBeGreaterThan(0);
    expect(refreshed.every((cookie) => /HttpOnly/i.test(cookie))).toBe(true);
    expect(response.headers.get("x-middleware-request-cookie")).not.toContain(
      cookieHeader,
    );
  });
});
