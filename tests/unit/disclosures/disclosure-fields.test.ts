import { describe, expect, it } from "vitest";

import {
  DISCLOSURE_LANGUAGE_LABELS,
  DISCLOSURE_LANGUAGE_OPTIONS,
  DISCLOSURE_MESSAGE_INPUT_LIMIT,
  DISCLOSURE_MESSAGE_MAX_LENGTH,
  countCharacters,
  languageLabel,
} from "@/features/disclosures/disclosure-fields";
import { disclosureMessageSchema } from "@/features/disclosures/disclosure";
import { DISCLOSURE_LANGUAGES } from "@/features/disclosures/languages";

/**
 * The disclosure editor's language picker (TASK-018): every stored code has
 * a label, the picker covers all 24 exactly once, sorted by that label, and
 * an unknown code shows as itself rather than throwing.
 */

describe("DISCLOSURE_LANGUAGE_LABELS", () => {
  it.each(DISCLOSURE_LANGUAGES)("has a non-empty label for %s", (code) => {
    expect(DISCLOSURE_LANGUAGE_LABELS[code].length).toBeGreaterThan(0);
  });
});

describe("DISCLOSURE_LANGUAGE_OPTIONS", () => {
  it("covers all 24 languages, each exactly once", () => {
    expect(DISCLOSURE_LANGUAGE_OPTIONS).toHaveLength(24);
    const values = DISCLOSURE_LANGUAGE_OPTIONS.map((option) => option.value);
    expect(new Set(values).size).toBe(24);
    expect([...values].sort()).toEqual([...DISCLOSURE_LANGUAGES].sort());
  });

  it("is sorted alphabetically by label", () => {
    const labels = DISCLOSURE_LANGUAGE_OPTIONS.map((option) => option.label);
    const sorted = [...labels].sort((a, b) => a.localeCompare(b, "en"));
    expect(labels).toEqual(sorted);
  });

  it("pairs each option's value with its own label", () => {
    for (const option of DISCLOSURE_LANGUAGE_OPTIONS) {
      expect(option.label).toBe(DISCLOSURE_LANGUAGE_LABELS[option.value]);
    }
  });
});

describe("languageLabel", () => {
  it.each(DISCLOSURE_LANGUAGES)("returns the English name for %s", (code) => {
    expect(languageLabel(code)).toBe(DISCLOSURE_LANGUAGE_LABELS[code]);
  });

  it("returns the code itself for an unknown code", () => {
    expect(languageLabel("xx")).toBe("xx");
  });

  it("returns the code itself for the wrong case of a known code", () => {
    expect(languageLabel("EN")).toBe("EN");
  });

  it("returns an empty string unchanged", () => {
    expect(languageLabel("")).toBe("");
  });
});

/**
 * The notice's length, as the editor shows it and as the schema enforces it
 * (PR #33 review, note 2, and note 4: one number, in the module a client
 * component may import).
 */
describe("the notice's length", () => {
  it("counts characters as code points, not UTF-16 units", () => {
    expect(countCharacters("abc")).toBe(3);
    // One emoji is one character to the database and to this counter, but
    // two units to JavaScript's own length.
    expect(countCharacters("\u{1f600}")).toBe(1);
    expect("\u{1f600}".length).toBe(2);
  });

  it("lets the textarea hold anything the schema would accept", () => {
    // HTML counts UTF-16 units, so the input limit must cover the longest a
    // valid notice can be: every character an astral one.
    const longestValid = "\u{1f600}".repeat(DISCLOSURE_MESSAGE_MAX_LENGTH);
    expect(disclosureMessageSchema.safeParse(longestValid).success).toBe(true);
    expect(longestValid.length).toBeLessThanOrEqual(
      DISCLOSURE_MESSAGE_INPUT_LIMIT,
    );
  });

  it("is the same number the schema refuses past", () => {
    expect(
      disclosureMessageSchema.safeParse(
        "a".repeat(DISCLOSURE_MESSAGE_MAX_LENGTH),
      ).success,
    ).toBe(true);
    expect(
      disclosureMessageSchema.safeParse(
        "a".repeat(DISCLOSURE_MESSAGE_MAX_LENGTH + 1),
      ).success,
    ).toBe(false);
  });
});
