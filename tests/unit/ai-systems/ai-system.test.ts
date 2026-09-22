import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  aiSystemListFilterSchema,
  createAiSystemSchema,
  serializeAiSystem,
  SYSTEM_STATUSES,
  SYSTEM_TYPES,
  updateAiSystemSchema,
} from "@/features/ai-systems/ai-system";

/**
 * The AI system schemas (TASK-009) against the table they write to
 * (TASK-008). A value the schemas accept must never be refused by the
 * table's CHECKs, or a valid request would surface as a 500.
 */

const MIGRATION = readFileSync(
  join(
    __dirname,
    "..",
    "..",
    "..",
    "supabase",
    "migrations",
    "20260921160000_ai_systems.sql",
  ),
  "utf8",
);

function checkList(constraint: string, column: string): string[] {
  const match = MIGRATION.match(
    new RegExp(`${constraint} check \\(\\s*${column} in \\(([^)]*)\\)`),
  );
  expect(match, constraint).not.toBeNull();
  return [...(match?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1] ?? "");
}

const RLO = String.fromCodePoint(0x202e);
const ZWSP = String.fromCodePoint(0x200b);
const ZWJ = String.fromCodePoint(0x200d);
const NUL = String.fromCodePoint(0x0);
const BELL = String.fromCodePoint(0x7);

describe("the schemas and the table agree", () => {
  it("on the system types", () => {
    expect(
      checkList("ai_systems_system_type_check", "system_type").sort(),
    ).toEqual([...SYSTEM_TYPES].sort());
  });

  it("on the statuses", () => {
    expect(checkList("ai_systems_status_check", "status").sort()).toEqual(
      [...SYSTEM_STATUSES].sort(),
    );
  });

  it.each([
    ["name", "char_length(name) between 1 and 120"],
    ["description", "char_length(description) between 1 and 2000"],
    ["provider", "char_length(provider) between 1 and 100"],
  ])("on the %s length", (_column, check) => {
    expect(MIGRATION).toContain(check);
  });
});

describe("createAiSystemSchema", () => {
  const valid = { name: "Support Bot", systemType: "chatbot" };

  it("accepts a minimal system and trims text", () => {
    expect(
      createAiSystemSchema.parse({
        ...valid,
        name: "  Support Bot  ",
        provider: " OpenAI ",
        description: "  Line one.\nLine two.\tTabbed.  ",
      }),
    ).toEqual({
      name: "Support Bot",
      systemType: "chatbot",
      provider: "OpenAI",
      description: "Line one.\nLine two.\tTabbed.",
    });
  });

  it("accepts an emoji joined by U+200D in a name", () => {
    expect(
      createAiSystemSchema.safeParse({
        ...valid,
        name: `Helper ${String.fromCodePoint(0x1f469)}${ZWJ}${String.fromCodePoint(0x1f4bb)}`,
      }).success,
    ).toBe(true);
  });

  it.each([
    ["organizationId", "0f6b2a4c-8d1e-4f3a-9b5c-6e7d8a9b0c1d"],
    ["organization_id", "0f6b2a4c-8d1e-4f3a-9b5c-6e7d8a9b0c1d"],
    ["id", "0f6b2a4c-8d1e-4f3a-9b5c-6e7d8a9b0c1d"],
    ["status", "archived"],
    ["createdAt", "2000-01-01T00:00:00Z"],
    ["system_type", "chatbot"],
  ])("refuses a body that also carries %s", (field, value) => {
    expect(
      createAiSystemSchema.safeParse({ ...valid, [field]: value }).success,
    ).toBe(false);
  });

  it.each([
    ["no name", { systemType: "chatbot" }],
    ["an empty name", { ...valid, name: "   " }],
    ["a 121-character name", { ...valid, name: "x".repeat(121) }],
    ["a name with a line break", { ...valid, name: "Two\nlines" }],
    ["a name with a right-to-left override", { ...valid, name: `Bot${RLO}x` }],
    [
      "a provider with a zero-width space",
      { ...valid, provider: `Open${ZWSP}AI` },
    ],
    ["a 101-character provider", { ...valid, provider: "x".repeat(101) }],
    ["a description with a NUL", { ...valid, description: `a${NUL}b` }],
    ["a description with a bell", { ...valid, description: `a${BELL}b` }],
    [
      "a 2001-character description",
      { ...valid, description: "x".repeat(2001) },
    ],
    ["an unknown type", { ...valid, systemType: "robot" }],
    ["no type", { name: "Support Bot" }],
  ])("refuses %s", (_label, body) => {
    expect(createAiSystemSchema.safeParse(body).success).toBe(false);
  });
});

describe("updateAiSystemSchema", () => {
  it("accepts any single field, and null to clear the description or provider", () => {
    for (const change of [
      { name: "Renamed" },
      { systemType: "assistant" },
      { description: null },
      { provider: null },
      { status: "archived" },
      { status: "active" },
    ]) {
      expect(updateAiSystemSchema.safeParse(change).success).toBe(true);
    }
  });

  it.each([
    ["an empty change", {}],
    ["a null name", { name: null }],
    ["an unknown status", { status: "deleted" }],
    ["an organizationId", { name: "x", organizationId: "anything" }],
    ["an id", { name: "x", id: "anything" }],
  ])("refuses %s", (_label, change) => {
    expect(updateAiSystemSchema.safeParse(change).success).toBe(false);
  });
});

describe("aiSystemListFilterSchema", () => {
  it("defaults to active", () => {
    expect(aiSystemListFilterSchema.parse(undefined)).toBe("active");
  });

  it.each(["active", "archived", "all"])("accepts %s", (value) => {
    expect(aiSystemListFilterSchema.parse(value)).toBe(value);
  });

  it.each(["deleted", "", "ALL"])("refuses %j", (value) => {
    expect(aiSystemListFilterSchema.safeParse(value).success).toBe(false);
  });
});

describe("serializeAiSystem", () => {
  it("sends seven fields and drops the rest", () => {
    expect(
      serializeAiSystem({
        id: "0f6b2a4c-8d1e-4f3a-9b5c-6e7d8a9b0c1d",
        organization_id: "5b0e8d1a-2c4f-4e6a-9b8c-7d1e2f3a4b5c",
        name: "Support Bot",
        description: null,
        system_type: "chatbot",
        provider: "OpenAI",
        status: "active",
        created_at: "2026-09-21T00:00:00Z",
        updated_at: "2026-09-21T10:00:00.123456+00:00",
      }),
    ).toEqual({
      id: "0f6b2a4c-8d1e-4f3a-9b5c-6e7d8a9b0c1d",
      name: "Support Bot",
      description: null,
      systemType: "chatbot",
      provider: "OpenAI",
      status: "active",
      // The database's string, microseconds included (TASK-010 review).
      updatedAt: "2026-09-21T10:00:00.123456+00:00",
    });
  });

  it("refuses a row that is not an AI system", () => {
    expect(() => serializeAiSystem({ id: "x" })).toThrow();
  });
});

describe("names are stored in Unicode's composed form (PR #23 review)", () => {
  const COMBINING_ACUTE = String.fromCodePoint(0x301);
  const decomposed = `Cafe${COMBINING_ACUTE} Bot`;
  const composed = `Caf${String.fromCodePoint(0xe9)} Bot`;

  it("a decomposed name becomes the composed one", () => {
    const parsed = createAiSystemSchema.parse({
      name: decomposed,
      systemType: "chatbot",
      provider: decomposed,
    });

    expect(parsed.name).toBe(composed);
    expect(parsed.provider).toBe(composed);
  });

  it("an edit's name is composed too", () => {
    expect(updateAiSystemSchema.parse({ name: decomposed }).name).toBe(
      composed,
    );
  });

  it("the length is counted after composing, as the table counts it", () => {
    const atLimit = `${"e".repeat(119)}e${COMBINING_ACUTE}`;

    expect(
      createAiSystemSchema.safeParse({ name: atLimit, systemType: "other" })
        .success,
    ).toBe(true);
  });
});
