import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { verificationCursorSchema } from "@/features/verification/verification-check";
import { VERIFICATION_LIST_LIMIT } from "@/features/verification/verification-history-queries";

/**
 * The history cursor (TASK-026).
 *
 * A cursor is the one value this endpoint takes from a query string, so it is
 * the one value a caller controls. It is read as text first and only then as a
 * time, and nothing that is not a timestamp reaches a query.
 */

describe("verificationCursorSchema", () => {
  it.each([
    ["2026-09-27T00:00:00.000Z"],
    ["2026-09-27T00:00:00Z"],
    ["2026-09-27T02:00:00+02:00"],
    ["2000-01-01T00:00:00.000Z"],
  ])("accepts %j and reads it as a time", (value) => {
    const parsed = verificationCursorSchema.safeParse(value);

    expect(parsed.success).toBe(true);
    expect(parsed.data?.toISOString()).toBe(new Date(value).toISOString());
  });

  it.each([
    ["2026-09-27", "a date with no time: the cursor is a window, not a day"],
    ["", "an empty string"],
    ["   ", "whitespace"],
    ["now", "a word"],
    ["1790500000000", "an epoch in milliseconds"],
    ["2026-09-27T00:00:00", "a time with no zone, which is ambiguous"],
    ["2026-13-45T00:00:00Z", "a month and a day that do not exist"],
    [
      "2026-09-27T00:00:00.000Z; drop table",
      "anything appended to a valid one",
    ],
  ])("refuses %j (%s)", (value) => {
    expect(verificationCursorSchema.safeParse(value).success).toBe(false);
  });

  it("refuses a value that is not a string", () => {
    // It arrives from a query parameter, so text is the only shape it has.
    for (const value of [null, undefined, 0, new Date(), {}, []]) {
      expect(verificationCursorSchema.safeParse(value).success).toBe(false);
    }
  });

  it("is a date a query can use, not the string it was given", () => {
    const parsed = verificationCursorSchema.parse("2026-09-27T00:00:00.000Z");

    expect(parsed).toBeInstanceOf(Date);
  });
});

describe("the page size", () => {
  it("is the same 200 as every other list here", () => {
    // One number across the query, the API and the screen: a reader who
    // follows a link gets the rows the endpoint would give them (TASK-018a).
    expect(VERIFICATION_LIST_LIMIT).toBe(200);
  });
});
