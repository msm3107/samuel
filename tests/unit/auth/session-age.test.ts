import { describe, expect, it } from "vitest";

import {
  isSessionExpired,
  lastSignInAt,
  SESSION_MAX_AGE_SECONDS,
} from "@/lib/auth/session-age";

const NOW = 1_800_000_000;
const DAY = 24 * 60 * 60;

function token(payload: unknown) {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "ES256" })}.${encode(payload)}.signature`;
}

function signedIn(...timestamps: number[]) {
  return token({
    amr: timestamps.map((timestamp) => ({ method: "otp", timestamp })),
  });
}

describe("lastSignInAt", () => {
  it("reads the newest amr timestamp, whatever the order", () => {
    expect(
      lastSignInAt(signedIn(NOW - 5 * DAY, NOW - DAY, NOW - 3 * DAY)),
    ).toBe(NOW - DAY);
  });

  it.each([
    ["no amr claim", token({ sub: "someone" })],
    ["an empty amr claim", token({ amr: [] })],
    ["the old string form", token({ amr: ["otp"] })],
    ["a text timestamp", token({ amr: [{ method: "otp", timestamp: "1" }] })],
    ["a payload that is not JSON", "a.bm90IGpzb24.c"],
    ["an opaque token", "opaque-access-token"],
    ["an empty string", ""],
  ])("returns null for %s", (_label, value) => {
    expect(lastSignInAt(value)).toBeNull();
  });
});

describe("isSessionExpired", () => {
  it("is 7 days", () => {
    expect(SESSION_MAX_AGE_SECONDS).toBe(7 * DAY);
  });

  it("accepts a session signed in exactly 7 days ago", () => {
    expect(isSessionExpired(signedIn(NOW - 7 * DAY), NOW)).toBe(false);
  });

  it("refuses a session signed in 7 days and 1 second ago", () => {
    expect(isSessionExpired(signedIn(NOW - 7 * DAY - 1), NOW)).toBe(true);
  });

  it("uses the latest sign-in when there are several", () => {
    expect(isSessionExpired(signedIn(NOW - 30 * DAY, NOW - DAY), NOW)).toBe(
      false,
    );
  });

  it("treats a timestamp ahead of the server clock as now", () => {
    expect(isSessionExpired(signedIn(NOW + 3600), NOW)).toBe(false);
  });

  it("fails closed on a token without a readable sign-in time", () => {
    expect(isSessionExpired(token({ sub: "someone" }), NOW)).toBe(true);
    expect(isSessionExpired("opaque-access-token", NOW)).toBe(true);
  });
});
