import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { serverEnv } from "@/lib/env/server-env";
import { hasCronSecret } from "@/lib/security/cron-auth";

/**
 * The only door on the scheduled verifier (TASK-025; PLAN Phase 7).
 *
 * That route acts with the service-role client on nobody's behalf: it reads
 * across every tenant and writes evidence customers rely on. Phase 7's
 * invariant is that it "rejects an absent, wrong, or short `CRON_SECRET`,
 * comparing in constant time", and these are the tests for it.
 */

const SECRET = serverEnv().CRON_SECRET;

function withHeader(value: string | null): Request {
  return new Request("https://app.example.com/api/cron/verify", {
    headers: value === null ? {} : { authorization: value },
  });
}

describe("a call that is not the scheduler", () => {
  it.each([
    ["no Authorization header at all", null],
    ["an empty header", ""],
    ["the scheme with nothing after it", "Bearer "],
    ["the scheme alone", "Bearer"],
    ["another scheme carrying the secret", `Basic ${SECRET}`],
    ["no scheme at all, just the secret", SECRET],
    ["an extra space before the secret", `Bearer  ${SECRET}`],
    ["the secret upper-cased", `Bearer ${SECRET.toUpperCase()}`],
    ["a prefix of the secret", `Bearer ${SECRET.slice(0, -1)}`],
    ["the secret plus one character", `Bearer ${SECRET}x`],
    [
      "a wrong secret of exactly the same length",
      `Bearer ${"z".repeat(SECRET.length)}`,
    ],
    ["an empty string", "Bearer ''"],
  ])("is refused with %s", (_what, header) => {
    expect(hasCronSecret(withHeader(header))).toBe(false);
  });

  it("is refused when the secret is in the query string instead", () => {
    // A URL reaches access logs, browser history and Referer headers, so a
    // secret in one is a secret in somebody's log file (README §16).
    const request = new Request(
      `https://app.example.com/api/cron/verify?secret=${encodeURIComponent(SECRET)}`,
    );

    expect(hasCronSecret(request)).toBe(false);
  });
});

describe("the scheduler's own call", () => {
  it("is accepted", () => {
    expect(hasCronSecret(withHeader(`Bearer ${SECRET}`))).toBe(true);
  });

  it("is accepted with a trailing space, which never reaches us", () => {
    // Not laxity on our part: the Fetch specification strips leading and
    // trailing HTTP whitespace from a header value, so the space is gone before
    // this function is called. Asserted rather than assumed, because the
    // alternative reading — that we trim the credential ourselves — would be a
    // real weakness, and this pins which of the two is happening.
    const request = withHeader(`Bearer ${SECRET} `);

    expect(request.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
    expect(hasCronSecret(request)).toBe(true);
  });

  it.each([["bearer"], ["BEARER"], ["BeArEr"]])(
    "is accepted with the scheme spelled %j",
    (scheme) => {
      // RFC 7235 makes an authentication scheme case-insensitive. Refusing a
      // spec-valid spelling would mean a verifier that silently never runs,
      // and the scheme is public — there is nothing to protect in it.
      expect(hasCronSecret(withHeader(`${scheme} ${SECRET}`))).toBe(true);
    },
  );
});

describe("how the comparison is done", () => {
  /**
   * The point of hashing both sides is that `timingSafeEqual` refuses buffers
   * of different lengths — so comparing raw values needs a length check in
   * front of it, and a length check before a constant-time comparison tells an
   * attacker how long the secret is.
   *
   * This is the test that proves the hashing is really there: without it, a
   * header of a different length would make `timingSafeEqual` throw a
   * `RangeError` rather than return false.
   */
  it.each([
    ["one character", "x"],
    ["one byte under the secret", "y".repeat(SECRET.length - 1)],
    ["ten thousand characters", "z".repeat(10_000)],
    // High bytes, which are legal in a header value and take more than one
    // byte once hashed as UTF-8. A character above U+00FF cannot be tested
    // here at all: a header value is a ByteString, so `new Request` refuses it
    // before this function could ever see it — as a real HTTP layer would.
    ["high bytes", "ÿ".repeat(64)],
  ])("returns false rather than throwing for %s", (_what, candidate) => {
    expect(() =>
      hasCronSecret(withHeader(`Bearer ${candidate}`)),
    ).not.toThrow();
    expect(hasCronSecret(withHeader(`Bearer ${candidate}`))).toBe(false);
  });

  it("never puts the secret in what it returns", () => {
    // It returns a boolean, which is the strongest form of this guarantee: the
    // caller is given no material to leak.
    expect(typeof hasCronSecret(withHeader(`Bearer ${SECRET}`))).toBe(
      "boolean",
    );
  });

  it("reads the header and nothing else about the request", () => {
    // Same secret, two different methods and URLs: the decision cannot depend
    // on anything else the request carries.
    const other = new Request("https://elsewhere.example.com/api/cron/verify", {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
    });

    expect(hasCronSecret(other)).toBe(true);
  });
});
