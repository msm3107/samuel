import { describe, expect, it } from "vitest";

import {
  hardenCookieOptions,
  SESSION_COOKIE_MAX_AGE_SECONDS,
} from "@/lib/database/session-cookie-options";

const SEVEN_DAYS = 7 * 24 * 60 * 60;
// @supabase/ssr's default maximum age for its cookies.
const LIBRARY_DEFAULT = 400 * 24 * 60 * 60;

describe("hardenCookieOptions: cookie lifetime (TASK-003e)", () => {
  it("matches the auth server's absolute session limit of 7 days", () => {
    expect(SESSION_COOKIE_MAX_AGE_SECONDS).toBe(SEVEN_DAYS);
  });

  it("caps the library's 400-day default at 7 days", () => {
    expect(hardenCookieOptions({ maxAge: LIBRARY_DEFAULT }).maxAge).toBe(
      SEVEN_DAYS,
    );
  });

  it("keeps a shorter maximum age", () => {
    expect(hardenCookieOptions({ maxAge: 3600 }).maxAge).toBe(3600);
  });

  it("keeps a removal, so signing out still deletes the cookie", () => {
    expect(hardenCookieOptions({ maxAge: 0 }).maxAge).toBe(0);
  });

  it("leaves a browser-session cookie without a maximum age", () => {
    expect(hardenCookieOptions({}).maxAge).toBeUndefined();
  });

  it("caps an expiry date beyond the limit", () => {
    const now = Date.now();
    const options = hardenCookieOptions({
      expires: new Date(now + LIBRARY_DEFAULT * 1000),
    });

    expect(options.expires).toBeUndefined();
    expect(options.maxAge).toBe(SEVEN_DAYS);
  });

  it("never lengthens a shorter maximum age while capping the expiry", () => {
    const options = hardenCookieOptions({
      maxAge: 3600,
      expires: new Date(Date.now() + LIBRARY_DEFAULT * 1000),
    });

    expect(options.maxAge).toBe(3600);
    expect(options.expires).toBeUndefined();
  });

  it("keeps a past expiry date, which is also a removal", () => {
    const past = new Date(0);

    expect(hardenCookieOptions({ expires: past }).expires).toBe(past);
  });
});
