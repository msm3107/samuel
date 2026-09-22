import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DISCLOSURE_LANGUAGES } from "@/features/disclosures/languages";

/**
 * The disclosure languages (TASK-016) are written out twice: in
 * `DISCLOSURE_LANGUAGES` and in the migrations' `disclosures_language_check`.
 * This keeps them equal, so a language added in one place and forgotten in
 * the other fails here instead of at a customer's first save.
 */

const MIGRATIONS_DIRECTORY = join(
  __dirname,
  "..",
  "..",
  "..",
  "supabase",
  "migrations",
);

/** The list in the latest migration that defines the constraint. */
function databaseLanguages(): string[] {
  const pattern =
    /disclosures_language_check check \(\s*language in \(([\s\S]*?)\)\s*\)/g;
  const lists = readdirSync(MIGRATIONS_DIRECTORY)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .flatMap((file) => [
      ...readFileSync(join(MIGRATIONS_DIRECTORY, file), "utf8").matchAll(
        pattern,
      ),
    ])
    .map((match) => match[1] ?? "");
  expect(lists.length).toBeGreaterThan(0);

  return (lists.at(-1) ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/^'|'$/g, ""))
    .filter((entry) => entry.length > 0);
}

describe("DISCLOSURE_LANGUAGES", () => {
  it("is the 24 official EU languages, each once", () => {
    expect(DISCLOSURE_LANGUAGES).toHaveLength(24);
    expect(new Set(DISCLOSURE_LANGUAGES).size).toBe(24);
    for (const code of DISCLOSURE_LANGUAGES) {
      expect(code).toMatch(/^[a-z]{2}$/);
    }
  });

  it("matches the database's constraint", () => {
    expect([...DISCLOSURE_LANGUAGES].sort()).toEqual(
      databaseLanguages().sort(),
    );
  });
});
