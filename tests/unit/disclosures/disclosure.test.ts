import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { publishDisclosureSchema } from "@/features/disclosures/disclosure";
import { serializeDisclosure } from "@/features/disclosures/disclosure-queries";
import { DISCLOSURE_LANGUAGES } from "@/features/disclosures/languages";

/**
 * The disclosure schema and serializer (TASK-017). The database holds the
 * same rules (TASK-016's `disclosures_message_check` and language list), so
 * everything here mirrors `supabase/tests/disclosures.test.sql`.
 */

const ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const USER_ID = "5b0e8d1a-2c4f-4e6a-9b8c-7d1e2f3a4b5c";

const VALID = {
  message: "We use an AI chatbot to answer support questions.",
  language: "en",
  enabled: true,
  expectedVersion: null,
} as const;

describe("publishDisclosureSchema: trimming", () => {
  it("trims a leading no-break space (U+00A0) and a trailing ideographic space (U+3000)", () => {
    const parsed = publishDisclosureSchema.parse({
      ...VALID,
      message: `\u00a0Hello\u3000`,
    });
    expect(parsed.message).toBe("Hello");
  });

  it("trims ordinary ASCII spaces too", () => {
    const parsed = publishDisclosureSchema.parse({
      ...VALID,
      message: "  Hello  ",
    });
    expect(parsed.message).toBe("Hello");
  });

  it("refuses a message that is only whitespace", () => {
    expect(
      publishDisclosureSchema.safeParse({ ...VALID, message: "\u00a0\u3000" })
        .success,
    ).toBe(false);
  });
});

describe("publishDisclosureSchema: every Unicode space (general category Zs) is trimmed at both ends", () => {
  /**
   * Enumerates every code point in general category Zs, the same way
   * text.test.ts enumerates Cf, and checks the schema's `.trim()` removes
   * each one at either end. If JavaScript's trim left one in, a message
   * ending in it would pass here but be refused by the table's own
   * `disclosures_message_check` (PR #31 review, note 2).
   */
  function zsCodePoints(): number[] {
    const points: number[] = [];
    for (let point = 0; point <= 0x10ffff; point += 1) {
      if (point >= 0xd800 && point <= 0xdfff) {
        continue;
      }
      if (/\p{Zs}/u.test(String.fromCodePoint(point))) {
        points.push(point);
      }
    }
    return points;
  }

  const zs = zsCodePoints();

  it("finds at least the documented Unicode 16 Zs characters", () => {
    // U+0020, U+00A0, U+1680, U+2000-U+200A, U+202F, U+205F, U+3000: 17.
    expect(zs.length).toBeGreaterThanOrEqual(17);
  });

  it.each(zs.map((point) => [point.toString(16), point] as const))(
    "removes U+%s from both ends, leaving the core text untouched",
    (_label, point) => {
      const space = String.fromCodePoint(point);
      const parsed = publishDisclosureSchema.parse({
        ...VALID,
        message: `${space}a${space}`,
      });
      expect(parsed.message).toBe("a");
      expect(/\p{Zs}/u.test(parsed.message.at(0) ?? "")).toBe(false);
      expect(/\p{Zs}/u.test(parsed.message.at(-1) ?? "")).toBe(false);
    },
  );
});

describe("publishDisclosureSchema: NFC normalization", () => {
  it("normalizes 'e' + combining acute (U+0301) to the precomposed 'é' (U+00E9)", () => {
    const parsed = publishDisclosureSchema.parse({
      ...VALID,
      message: `e\u0301`,
    });
    expect(parsed.message).toBe("é");
    expect([...parsed.message].length).toBe(1);
  });

  it("counts length after normalization, not before", () => {
    // 500 decomposed sequences would be 1000 UTF-16 units and 500 code
    // points before normalizing, but 500 code points after: accepted.
    const decomposed = `e\u0301`.repeat(500);
    const parsed = publishDisclosureSchema.parse({
      ...VALID,
      message: decomposed,
    });
    expect([...parsed.message].length).toBe(500);
  });
});

describe("publishDisclosureSchema: length, in code points", () => {
  it("accepts exactly 500 code points, including 500 emoji", () => {
    const emoji = String.fromCodePoint(0x1f600).repeat(500);
    expect([...emoji].length).toBe(500);
    expect(
      publishDisclosureSchema.safeParse({ ...VALID, message: emoji }).success,
    ).toBe(true);
  });

  it("refuses 501 code points, including 501 emoji", () => {
    const emoji = String.fromCodePoint(0x1f600).repeat(501);
    expect([...emoji].length).toBe(501);
    expect(
      publishDisclosureSchema.safeParse({ ...VALID, message: emoji }).success,
    ).toBe(false);
  });

  it("accepts a single character", () => {
    expect(
      publishDisclosureSchema.safeParse({ ...VALID, message: "x" }).success,
    ).toBe(true);
  });
});

describe("publishDisclosureSchema: disallowed characters inside the message", () => {
  it.each([
    ["a control character other than a line break", "Hi\u0007there"],
    ["a right-to-left override (U+202E)", "evil\u202etxt.exe"],
    ["a zero-width space (U+200B)", "Ac\u200bme"],
    ["a line separator (U+2028)", "Line\u2028break"],
    ["a paragraph separator (U+2029)", "Para\u2029break"],
  ])("refuses %s", (_label, fragment) => {
    expect(
      publishDisclosureSchema.safeParse({ ...VALID, message: fragment })
        .success,
    ).toBe(false);
  });

  it("allows a zero-width joiner (U+200D), for emoji and scripts that need it", () => {
    const message = `${String.fromCodePoint(0x1f469)}\u200d${String.fromCodePoint(0x1f4bb)} Studio`;
    expect(
      publishDisclosureSchema.safeParse({ ...VALID, message }).success,
    ).toBe(true);
  });
});

describe("publishDisclosureSchema: language", () => {
  it.each(DISCLOSURE_LANGUAGES)("accepts %s", (language) => {
    expect(
      publishDisclosureSchema.safeParse({ ...VALID, language }).success,
    ).toBe(true);
  });

  it("refuses the right case with the wrong case: EN", () => {
    expect(
      publishDisclosureSchema.safeParse({ ...VALID, language: "EN" }).success,
    ).toBe(false);
  });

  it("refuses a language not on the list: xx", () => {
    expect(
      publishDisclosureSchema.safeParse({ ...VALID, language: "xx" }).success,
    ).toBe(false);
  });
});

describe("publishDisclosureSchema: enabled", () => {
  it("is required", () => {
    const { enabled: _enabled, ...withoutEnabled } = VALID;
    expect(publishDisclosureSchema.safeParse(withoutEnabled).success).toBe(
      false,
    );
  });

  it("refuses undefined explicitly", () => {
    expect(
      publishDisclosureSchema.safeParse({ ...VALID, enabled: undefined })
        .success,
    ).toBe(false);
  });

  it.each([true, false])("accepts %s", (enabled) => {
    expect(
      publishDisclosureSchema.safeParse({ ...VALID, enabled }).success,
    ).toBe(true);
  });
});

describe("publishDisclosureSchema: expectedVersion", () => {
  it("accepts null: the system has no version yet", () => {
    expect(
      publishDisclosureSchema.safeParse({ ...VALID, expectedVersion: null })
        .success,
    ).toBe(true);
  });

  it.each([1, 2, 2_147_483_647])("accepts the integer %d", (value) => {
    expect(
      publishDisclosureSchema.safeParse({ ...VALID, expectedVersion: value })
        .success,
    ).toBe(true);
  });

  it.each([
    ["0, below the minimum", 0],
    ["1.5, not an integer", 1.5],
    ["2147483648, over Postgres's integer range", 2_147_483_648],
    ["-1, negative", -1],
  ])("refuses %s", (_label, value) => {
    expect(
      publishDisclosureSchema.safeParse({ ...VALID, expectedVersion: value })
        .success,
    ).toBe(false);
  });

  it('refuses "1" as a string', () => {
    expect(
      publishDisclosureSchema.safeParse({ ...VALID, expectedVersion: "1" })
        .success,
    ).toBe(false);
  });

  it("is required: missing entirely is refused", () => {
    const { expectedVersion: _expectedVersion, ...withoutVersion } = VALID;
    expect(publishDisclosureSchema.safeParse(withoutVersion).success).toBe(
      false,
    );
  });
});

describe("publishDisclosureSchema: strict, unknown fields refused", () => {
  it.each([
    ["organizationId", () => "5b0e8d1a-2c4f-4e6a-9b8c-7d1e2f3a4b5c"],
    ["aiSystemId", () => ID],
    ["version", () => 1],
    ["createdBy", () => USER_ID],
    ["id", () => ID],
    ["createdAt", () => "2026-09-22T00:00:00Z"],
  ])("refuses a body that also carries %s", (field, value) => {
    expect(
      publishDisclosureSchema.safeParse({ ...VALID, [field]: value() }).success,
    ).toBe(false);
  });
});

describe("serializeDisclosure", () => {
  const ROW = {
    id: ID,
    version: 3,
    message: "We use an AI chatbot.",
    language: "en",
    enabled: true,
    created_at: "2026-09-22T10:00:00.123456+00:00",
    created_by: USER_ID,
  };

  it("builds the response field by field", () => {
    expect(serializeDisclosure(ROW)).toEqual({
      id: ID,
      version: 3,
      message: "We use an AI chatbot.",
      language: "en",
      enabled: true,
      createdAt: "2026-09-22T10:00:00.123456+00:00",
      createdBy: USER_ID,
    });
  });

  it("drops extra columns the row carries, whatever else the query returns", () => {
    const result = serializeDisclosure({
      ...ROW,
      organization_id: "5b0e8d1a-2c4f-4e6a-9b8c-7d1e2f3a4b5c",
      ai_system_id: ID,
      secret_internal_column: "should never surface",
    });
    expect(Object.keys(result).sort()).toEqual(
      [
        "id",
        "version",
        "message",
        "language",
        "enabled",
        "createdAt",
        "createdBy",
      ].sort(),
    );
  });

  it("is frozen", () => {
    const result = serializeDisclosure(ROW);
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => {
      // @ts-expect-error -- intentionally mutating a Readonly type to prove it is frozen at runtime.
      result.message = "changed";
    }).toThrow();
  });

  it.each([
    ["a row missing every field", { id: "x" }],
    ["an id that is not a uuid", { ...ROW, id: "not-a-uuid" }],
    ["a version below 1", { ...ROW, version: 0 }],
    ["a non-integer version", { ...ROW, version: 1.5 }],
    ["a language not in the list", { ...ROW, language: "xx" }],
    ["a non-boolean enabled", { ...ROW, enabled: "true" }],
    [
      "a created_at that isn't a timestamp",
      { ...ROW, created_at: "yesterday" },
    ],
    ["a created_by that is not a uuid", { ...ROW, created_by: "not-a-uuid" }],
    ["a non-string message", { ...ROW, message: 123 }],
  ])("rejects %s", (_label, row) => {
    expect(() => serializeDisclosure(row)).toThrow();
  });
});
