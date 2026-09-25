import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { SerializedDisclosure } from "@/features/disclosures/disclosure";
import {
  formValuesOf,
  parseDisclosureForm,
} from "@/features/disclosures/disclosure-form";
import {
  ENABLED_FIELD,
  LANGUAGE_FIELD,
  MESSAGE_FIELD,
  VERSION_FIELD,
} from "@/features/disclosures/disclosure-fields";

/**
 * The disclosure editor's form parsing (TASK-018): what `parseDisclosureForm`
 * reads from a submission, and what it ignores. The message and language
 * rules themselves belong to `publishDisclosureSchema`
 * (tests/unit/disclosures/disclosure.test.ts); this is about turning a form
 * into that schema's input, and the version field the schema doesn't have.
 */

const ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const USER_ID = "5b0e8d1a-2c4f-4e6a-9b8c-7d1e2f3a4b5c";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    data.append(name, value);
  }
  return data;
}

function validFields(overrides: Record<string, string> = {}) {
  return {
    [MESSAGE_FIELD]: "A brief notice about our AI system.",
    [LANGUAGE_FIELD]: "en",
    [ENABLED_FIELD]: "on",
    ...overrides,
  };
}

describe("parseDisclosureForm: only the four named fields are read", () => {
  it("reads message, language, enabled and expectedVersion, and ignores everything else", () => {
    const parsed = parseDisclosureForm(
      form({
        ...validFields(),
        [VERSION_FIELD]: "3",
        organizationId: "0f6b2a4c-8d1e-4f3a-9b5c-6e7d8a9b0c1d",
        aiSystemId: ID,
        id: ID,
        version: "999",
        createdBy: USER_ID,
        createdAt: "2026-09-22T00:00:00Z",
      }),
    );

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toEqual({
        message: "A brief notice about our AI system.",
        language: "en",
        enabled: true,
        expectedVersion: 3,
      });
      expect(Object.keys(parsed.data).sort()).toEqual(
        ["message", "language", "enabled", "expectedVersion"].sort(),
      );
    }
  });
});

describe("parseDisclosureForm: enabled is a checkbox", () => {
  it("an unchecked checkbox (absent from the form) reads as enabled: false", () => {
    const data = form(validFields());
    data.delete(ENABLED_FIELD);

    const parsed = parseDisclosureForm(data);

    expect(parsed.values.enabled).toBe(false);
    expect(parsed.success && parsed.data.enabled).toBe(false);
  });

  it("a checked checkbox reads as enabled: true", () => {
    const parsed = parseDisclosureForm(form(validFields()));

    expect(parsed.values.enabled).toBe(true);
    expect(parsed.success && parsed.data.enabled).toBe(true);
  });
});

// Built with String.fromCharCode, not written as a literal escape in a
// string literal: that escape can come out the other side of a file write
// as the literal character itself, which must never happen (AGENTS.md).
const LINE_SEPARATOR = String.fromCharCode(0x2028);

describe("parseDisclosureForm: line breaks in the message", () => {
  it.each([
    ["a line feed (\\n)", "Hello\nthere"],
    ["a CRLF pair (\\r\\n)", "Hello\r\nthere"],
    ["a line separator (U+2028)", `Hello${LINE_SEPARATOR}there`],
  ])("refuses %s, naming the message field", (_label, message) => {
    const parsed = parseDisclosureForm(
      form(validFields({ [MESSAGE_FIELD]: message })),
    );

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.fields).toEqual(["message"]);
    }
  });

  it("trims a trailing line break and accepts the message", () => {
    const parsed = parseDisclosureForm(
      form(validFields({ [MESSAGE_FIELD]: "Hello there\n" })),
    );

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.message).toBe("Hello there");
    }
  });

  it("trims a trailing CRLF and accepts the message", () => {
    const parsed = parseDisclosureForm(
      form(validFields({ [MESSAGE_FIELD]: "Hello there\r\n" })),
    );

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.message).toBe("Hello there");
    }
  });
});

describe("parseDisclosureForm: message length, in code points", () => {
  it("accepts exactly 500 emoji", () => {
    const message = String.fromCodePoint(0x1f600).repeat(500);

    const parsed = parseDisclosureForm(
      form(validFields({ [MESSAGE_FIELD]: message })),
    );

    expect(parsed.success).toBe(true);
  });

  it("refuses 501 emoji, naming the message field", () => {
    const message = String.fromCodePoint(0x1f600).repeat(501);

    const parsed = parseDisclosureForm(
      form(validFields({ [MESSAGE_FIELD]: message })),
    );

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.fields).toEqual(["message"]);
    }
  });
});

describe("parseDisclosureForm: the version field", () => {
  it("no version field at all: none", () => {
    const data = form(validFields());
    data.delete(VERSION_FIELD);

    const parsed = parseDisclosureForm(data);

    expect(parsed.expectedVersion).toEqual({ kind: "none" });
    expect(parsed.success && parsed.data.expectedVersion).toBe(null);
  });

  it("a valid number: version", () => {
    const parsed = parseDisclosureForm(
      form(validFields({ [VERSION_FIELD]: "42" })),
    );

    expect(parsed.expectedVersion).toEqual({ kind: "version", value: 42 });
    expect(parsed.success && parsed.data.expectedVersion).toBe(42);
  });

  it.each([
    ["non-numeric text", "abc"],
    ["empty", ""],
    ["zero", "0"],
    ["negative", "-1"],
    ["fractional", "1.5"],
    ["over Postgres's integer range", "2147483648"],
  ])("%s: unreadable", (_label, value) => {
    const parsed = parseDisclosureForm(
      form(validFields({ [VERSION_FIELD]: value })),
    );

    expect(parsed.expectedVersion).toEqual({ kind: "unreadable" });
  });

  it("the maximum integer is a version", () => {
    const parsed = parseDisclosureForm(
      form(validFields({ [VERSION_FIELD]: "2147483647" })),
    );

    expect(parsed.expectedVersion).toEqual({
      kind: "version",
      value: 2_147_483_647,
    });
  });
});

describe("formValuesOf", () => {
  it("round-trips a serialized disclosure into the editor's values", () => {
    const disclosure: SerializedDisclosure = Object.freeze({
      id: ID,
      version: 3,
      message: "We use an AI chatbot.",
      language: "fr",
      enabled: false,
      createdAt: "2026-09-22T10:00:00.000000+00:00",
      createdBy: USER_ID,
    });

    expect(formValuesOf(disclosure)).toEqual({
      message: "We use an AI chatbot.",
      language: "fr",
      enabled: false,
    });
  });
});

describe("parseDisclosureForm: a non-FormData input", () => {
  it("reads no values and no version, and is refused", () => {
    const parsed = parseDisclosureForm({ [MESSAGE_FIELD]: "Hello" });

    // Not a FormData at all, so `submittedValues` falls back to the blank
    // editor's defaults (EMPTY_DISCLOSURE_FORM_VALUES), not a hand-built
    // empty record: `enabled` there defaults to true.
    expect(parsed.values).toEqual({ message: "", language: "", enabled: true });
    expect(parsed.expectedVersion).toEqual({ kind: "none" });
    expect(parsed.success).toBe(false);
  });

  it("handles null and undefined the same way", () => {
    for (const input of [null, undefined]) {
      const parsed = parseDisclosureForm(input);
      expect(parsed.values).toEqual({
        message: "",
        language: "",
        enabled: true,
      });
      expect(parsed.success).toBe(false);
    }
  });
});
