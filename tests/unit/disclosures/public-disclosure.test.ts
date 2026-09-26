import { describe, expect, it } from "vitest";

import { DISCLOSURE_MESSAGE_MAX_LENGTH } from "@/features/disclosures/disclosure-fields";
import {
  publicDisclosureRowsSchema,
  publicDisclosureSchema,
} from "@/features/disclosures/public-disclosure";

/**
 * The public response's shape (TASK-019a). The database is external input
 * like any other, and this schema is what makes "three keys and nothing
 * else" true of the wire rather than only of the SQL: a column added to
 * `public.public_disclosure`'s return type fails here instead of appearing
 * on a public endpoint.
 */

const NOTICE = {
  version: 3,
  language: "en",
  message: "You are interacting with an AI system.",
};

describe("the public disclosure row", () => {
  it("accepts the three fields the function returns", () => {
    expect(publicDisclosureSchema.parse(NOTICE)).toEqual(NOTICE);
  });

  it("refuses a fourth field rather than dropping it", () => {
    // Strict, not stripped: a new column must be a failure someone reads,
    // not a value that quietly starts or stops being sent.
    expect(
      publicDisclosureSchema.safeParse({
        ...NOTICE,
        learnMoreUrl: "https://example.com",
      }).success,
    ).toBe(false);
  });

  it.each([
    ["no version", { language: "en", message: "x" }],
    ["no language", { version: 1, message: "x" }],
    ["no message", { version: 1, language: "en" }],
    ["a version of zero", { ...NOTICE, version: 0 }],
    ["a version that is not whole", { ...NOTICE, version: 1.5 }],
    [
      "a version past Postgres's integer",
      { ...NOTICE, version: 2_147_483_648 },
    ],
    ["a language outside the published list", { ...NOTICE, language: "xx" }],
    ["an empty message", { ...NOTICE, message: "" }],
    [
      "a message past the table's own limit",
      { ...NOTICE, message: "x".repeat(DISCLOSURE_MESSAGE_MAX_LENGTH + 1) },
    ],
    ["a version sent as text", { ...NOTICE, version: "3" }],
    ["null", null],
  ])("refuses %s", (_case, value) => {
    expect(publicDisclosureSchema.safeParse(value).success).toBe(false);
  });
});

describe("the function's answer", () => {
  it("is nothing or one row", () => {
    expect(publicDisclosureRowsSchema.parse([])).toEqual([]);
    expect(publicDisclosureRowsSchema.parse([NOTICE])).toEqual([NOTICE]);
  });

  it("refuses two rows rather than picking one", () => {
    // At most one is true by construction: the identifier is unique and
    // only the system's current version can match. Two means the function
    // changed under the application.
    expect(
      publicDisclosureRowsSchema.safeParse([NOTICE, { ...NOTICE, version: 2 }])
        .success,
    ).toBe(false);
  });

  it("refuses an answer that is not an array", () => {
    expect(publicDisclosureRowsSchema.safeParse(NOTICE).success).toBe(false);
    expect(publicDisclosureRowsSchema.safeParse(null).success).toBe(false);
  });
});
