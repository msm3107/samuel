import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { organizationNameSchema } from "@/features/organizations/organization";
import { hasControlCharacter, hasFormatCharacter } from "@/lib/validation/text";

/**
 * The application's and the database's definitions of "format character"
 * must agree, or a name one accepts is refused by the other (TASK-008, PR #22
 * review finding 2). Postgres has no `\p{Cf}`, so the migrations spell the
 * ranges out; this compares them with JavaScript's `\p{Cf}` code point by
 * code point.
 */

const MIGRATIONS_DIRECTORY = join(
  __dirname,
  "..",
  "..",
  "..",
  "supabase",
  "migrations",
);

/** Every bracket expression that starts with the soft hyphen, U+00AD. */
function formatPatternsInMigrations(): string[] {
  return readdirSync(MIGRATIONS_DIRECTORY)
    .filter((file) => file.endsWith(".sql"))
    .flatMap((file) => [
      ...readFileSync(join(MIGRATIONS_DIRECTORY, file), "utf8").matchAll(
        /'(\[\\u00ad[^\]]*\])'/g,
      ),
    ])
    .map((match) => match[1] ?? "");
}

/** Reads a Postgres bracket of `\uXXXX` / `\UXXXXXXXX` escapes and ranges. */
function codePointsOf(bracket: string): Set<number> {
  const escape = String.raw`\\(?:u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8}))`;
  const item = new RegExp(`${escape}(?:-${escape})?`, "g");
  const inner = bracket.slice(1, -1);
  const points = new Set<number>();
  let consumed = 0;
  for (const match of inner.matchAll(item)) {
    expect(match.index, "only escapes and ranges").toBe(consumed);
    consumed += match[0].length;
    const from = parseInt(match[1] ?? match[2] ?? "", 16);
    const to = match[3] ?? match[4];
    const end = to === undefined ? from : parseInt(to, 16);
    for (let point = from; point <= end; point += 1) {
      points.add(point);
    }
  }
  expect(consumed).toBe(inner.length);
  return points;
}

function javascriptFormatCharacters(): Set<number> {
  const points = new Set<number>();
  for (let point = 0; point <= 0x10ffff; point += 1) {
    if (point >= 0xd800 && point <= 0xdfff) {
      continue;
    }
    if (hasFormatCharacter(String.fromCodePoint(point))) {
      points.add(point);
    }
  }
  return points;
}

describe("the database and the application agree on format characters", () => {
  const patterns = formatPatternsInMigrations();

  it("finds the pattern in each check: ai_systems name and provider, organizations, create_organization", () => {
    expect(patterns.length).toBeGreaterThanOrEqual(4);
    expect(new Set(patterns).size).toBe(1);
  });

  it("covers exactly JavaScript's \\p{Cf} less the zero-width joiner", () => {
    const database = codePointsOf(patterns[0] ?? "[]");
    const application = javascriptFormatCharacters();

    expect([...application].filter((point) => !database.has(point))).toEqual(
      [],
    );
    expect([...database].filter((point) => !application.has(point))).toEqual(
      [],
    );
    expect(database.has(0x200d)).toBe(false);
  });
});

describe("hasFormatCharacter", () => {
  it.each([
    ["a right-to-left override", "evil\u202Etxt.exe"],
    ["a zero-width space", "Acme\u200BLtd"],
    ["a byte order mark", "\uFEFFAcme"],
    ["an invisible tag", "Acme\u{E0041}"],
    ["a soft hyphen", "Ac\u00ADme"],
  ])("finds %s", (_label, value) => {
    expect(hasFormatCharacter(value)).toBe(true);
  });

  it.each([
    ["plain Polish", "Zażółć Gęślą Jaźń"],
    ["an emoji joined by U+200D", "\u{1F469}\u200D\u{1F4BB} Studio"],
    ["Arabic", "شركة"],
  ])("allows %s", (_label, value) => {
    expect(hasFormatCharacter(value)).toBe(false);
  });
});

describe("hasControlCharacter", () => {
  it.each([
    ["NUL", "\u0000"],
    ["a tab", "\u0009"],
    ["a line feed", "\u000A"],
    ["DEL", "\u007F"],
    ["a C1 control", "\u0085"],
  ])("finds %s", (_label, value) => {
    expect(hasControlCharacter(`a${value}b`)).toBe(true);
  });

  it("allows ordinary text", () => {
    expect(hasControlCharacter("Acme Ltd.")).toBe(false);
  });
});

describe("organization names", () => {
  it("refuse a right-to-left override and a zero-width space", () => {
    expect(organizationNameSchema.safeParse("Acme\u202Ecorp").success).toBe(
      false,
    );
    expect(organizationNameSchema.safeParse("Ac\u200Bme").success).toBe(false);
  });

  it("allow an emoji joined by U+200D", () => {
    expect(
      organizationNameSchema.safeParse("\u{1F469}\u200D\u{1F4BB} Studio")
        .success,
    ).toBe(true);
  });
});
