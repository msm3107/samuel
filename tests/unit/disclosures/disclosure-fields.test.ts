import { describe, expect, it } from "vitest";

import {
  DISCLOSURE_LANGUAGE_LABELS,
  DISCLOSURE_LANGUAGE_OPTIONS,
  languageLabel,
} from "@/features/disclosures/disclosure-fields";
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
