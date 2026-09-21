import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createOrganizationMessage } from "@/app/(dashboard)/dashboard/messages";
import {
  organizationNameSchema,
  serializeOrganization,
} from "@/features/organizations/organization";

const REPOSITORY_ROOT = join(__dirname, "..", "..", "..");
const MIGRATION = readFileSync(
  join(
    REPOSITORY_ROOT,
    "supabase",
    "migrations",
    "20260921150000_create_organization.sql",
  ),
  "utf8",
);

describe("organizationNameSchema", () => {
  it.each([
    ["Acme", "Acme"],
    ["  Acme Ltd  ", "Acme Ltd"],
    ["Zażółć Gęślą Jaźń", "Zażółć Gęślą Jaźń"],
    ["x".repeat(120), "x".repeat(120)],
  ])("accepts %j as %j", (input, expected) => {
    expect(organizationNameSchema.parse(input)).toBe(expected);
  });

  it.each([
    ["an empty name", ""],
    ["only spaces", "   "],
    ["121 characters", "x".repeat(121)],
    ["a line break", "Line\nbreak"],
    ["a tab", "Tab\there"],
    ["a NUL", "Nul\u0000"],
    ["DEL", "Del\u007f"],
    ["a C1 control", "C1\u0085"],
    ["a number", 42],
    ["null", null],
  ])("refuses %s", (_label, input) => {
    expect(organizationNameSchema.safeParse(input).success).toBe(false);
  });
});

describe("serializeOrganization", () => {
  it("keeps id, name and slug and drops everything else", () => {
    const serialized = serializeOrganization({
      id: "0f6b2a4c-8d1e-4f3a-9b5c-6e7d8a9b0c1d",
      name: "Acme",
      slug: "acme",
      created_at: "2026-09-21T00:00:00Z",
      deleted_at: null,
    });

    expect(serialized).toEqual({
      id: "0f6b2a4c-8d1e-4f3a-9b5c-6e7d8a9b0c1d",
      name: "Acme",
      slug: "acme",
    });
    expect(Object.isFrozen(serialized)).toBe(true);
  });

  it("refuses a row that is not an organization", () => {
    expect(() => serializeOrganization({ id: "nope" })).toThrow();
    expect(() => serializeOrganization(null)).toThrow();
  });
});

describe("the create form's messages", () => {
  it("shows fixed text for a known code", () => {
    expect(createOrganizationMessage("limit_reached")).toMatch(/10/);
  });

  it.each([
    "<script>alert(1)</script>",
    "constructor",
    "__proto__",
    "toString",
    ["limit_reached"],
    undefined,
  ])("shows nothing for %j", (value) => {
    expect(createOrganizationMessage(value)).toBeNull();
  });
});

describe("reserved slugs stay in step with the application's routes", () => {
  const reserved = new Set(
    [
      ...(
        MIGRATION.match(
          /c_reserved constant text\[\] := array\[([\s\S]*?)\];/,
        )?.[1] ?? ""
      ).matchAll(/'([^']+)'/g),
    ].map((match) => match[1]),
  );

  /** Each URL's first segment: route groups, `(name)`, add none. */
  function topLevelSegments(directory: string): string[] {
    return readdirSync(directory).flatMap((entry) => {
      const path = join(directory, entry);
      if (!statSync(path).isDirectory()) {
        return [];
      }
      if (entry.startsWith("(") && entry.endsWith(")")) {
        return topLevelSegments(path);
      }
      // Private folders and dynamic segments are not fixed words.
      if (entry.startsWith("_") || entry.startsWith("[")) {
        return [];
      }
      return [entry];
    });
  }

  it("finds the list in the migration", () => {
    expect(reserved.size).toBeGreaterThan(20);
  });

  it("reserves every top-level route segment under app/", () => {
    const segments = topLevelSegments(join(REPOSITORY_ROOT, "app"));

    expect(segments.length).toBeGreaterThan(0);
    for (const segment of segments) {
      expect(reserved, `app/ route "${segment}"`).toContain(segment);
    }
  });

  it("reserves the fallback base, so a name without letters always gets a suffix", () => {
    expect(reserved).toContain("org");
  });
});

describe("organization names are stored in Unicode's composed form (PR #23 review)", () => {
  it("a decomposed name becomes the composed one", () => {
    expect(
      organizationNameSchema.parse(`Cafe${String.fromCodePoint(0x301)}`),
    ).toBe(`Caf${String.fromCodePoint(0xe9)}`);
  });
});
