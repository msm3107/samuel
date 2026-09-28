import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  CHECK_SCHEDULE,
  CHECK_STATUS_LABELS,
  checksPath,
  FAILURE_CODE_EXPLANATIONS,
  REDIRECT_REASON_EXPLANATIONS,
  reasonExplanation,
  WHAT_A_CHECK_DOES,
  WIDGET_REASON_EXPLANATIONS,
} from "@/app/(dashboard)/dashboard/[organizationId]/deployments/[deploymentId]/checks/messages";
import {
  REDIRECT_REASONS,
  VERIFICATION_FAILURE_CODES,
  VERIFICATION_STATUSES,
  WIDGET_REASONS,
} from "@/features/verification/verification-check";

/**
 * What the verification history screen says (TASK-027).
 *
 * The tables are total by construction — `satisfies Record<…>` refuses a
 * missing key and an unknown one alike — so these tests cover what a type
 * cannot: that the text is usable, that a stored code can always be turned into
 * words, and that no sentence claims more than a check observed.
 */

const TABLES = [
  ["failure codes", FAILURE_CODE_EXPLANATIONS, VERIFICATION_FAILURE_CODES],
  ["widget reasons", WIDGET_REASON_EXPLANATIONS, WIDGET_REASONS],
  ["redirect reasons", REDIRECT_REASON_EXPLANATIONS, REDIRECT_REASONS],
] as const;

describe.each(TABLES)("the %s table", (_name, table, vocabulary) => {
  it("has an entry for every value in the vocabulary, and no other", () => {
    // The type already says so. Asserted anyway because the vocabularies are
    // also written out in a migration's check constraint: a value that reaches
    // a row without reaching this table is a screen with a blank where the
    // reason should be.
    expect(Object.keys(table).sort()).toEqual([...vocabulary].sort());
  });

  it("gives every entry a short label and a sentence", () => {
    for (const entry of Object.values(table)) {
      expect(entry.label.length).toBeGreaterThan(0);
      // A row shows the label beside a date and a badge, so it has to stay on
      // the line rather than wrapping the list into paragraphs.
      expect(entry.label.length).toBeLessThanOrEqual(34);
      expect(entry.label.endsWith(".")).toBe(false);
      expect(entry.detail.endsWith(".")).toBe(true);
      expect(entry.detail.length).toBeGreaterThan(entry.label.length);
    }
  });
});

describe("what the screen never claims", () => {
  // §21 and §72: the product documents configuration and verification
  // activity. It does not certify anything, and this is the first screen whose
  // subject is evidence — the first place the words would be tempting. Phase 9
  // requires the same test of a report; it is cheaper to start here than to
  // find the vocabulary already in the codebase then.
  const FORBIDDEN = /certificat|compliant|compliance|guarantee|verified by/i;

  const everything = [
    WHAT_A_CHECK_DOES,
    CHECK_SCHEDULE,
    ...Object.values(CHECK_STATUS_LABELS),
    ...TABLES.flatMap(([, table]) =>
      Object.values(table).flatMap((entry) => [entry.label, entry.detail]),
    ),
  ];

  it.each(everything)("says nothing of the kind in %j", (text) => {
    expect(FORBIDDEN.test(text)).toBe(false);
  });

  it("states the schedule without promising a time", () => {
    // TASK-025 shipped the route; the schedule is enabled outside the
    // application, so a promise here could silently stop being true.
    expect(CHECK_SCHEDULE).not.toMatch(/within|next|will be|expect/i);
  });
});

describe("a status", () => {
  it("is a word for every status, not a colour", () => {
    expect(Object.keys(CHECK_STATUS_LABELS).sort()).toEqual(
      [...VERIFICATION_STATUSES].sort(),
    );
    for (const label of Object.values(CHECK_STATUS_LABELS)) {
      expect(label).toMatch(/^[A-Z][a-z]+$/);
    }
  });
});

describe("reasonExplanation", () => {
  it("finds every widget reason", () => {
    for (const reason of WIDGET_REASONS) {
      expect(
        reasonExplanation({ widgetReason: reason, redirectReason: null }),
      ).toBe(WIDGET_REASON_EXPLANATIONS[reason]);
    }
  });

  it("finds every redirect reason", () => {
    for (const reason of REDIRECT_REASONS) {
      expect(
        reasonExplanation({ widgetReason: null, redirectReason: reason }),
      ).toBe(REDIRECT_REASON_EXPLANATIONS[reason]);
    }
  });

  it("has nothing to say when the check observed neither", () => {
    expect(
      reasonExplanation({ widgetReason: null, redirectReason: null }),
    ).toBeUndefined();
  });

  it("renders an unrecognized reason as no detail rather than as an error", () => {
    // Both vocabularies are public from this task on. A value added by a later
    // migration must not blank the screen or throw here: the failure code's own
    // sentence still shows, so a reader is never left with nothing.
    expect(
      reasonExplanation({ widgetReason: "NEW_REASON", redirectReason: null }),
    ).toBeUndefined();
    expect(
      reasonExplanation({ widgetReason: null, redirectReason: "NEW_REASON" }),
    ).toBeUndefined();
  });

  it("cannot be tricked into reading a property from the prototype", () => {
    // The lookup is by a string that came from a database column. `hasOwn`
    // rather than `in`, so a value naming an inherited property finds nothing.
    expect(
      reasonExplanation({ widgetReason: "toString", redirectReason: null }),
    ).toBeUndefined();
    expect(
      reasonExplanation({ widgetReason: "constructor", redirectReason: null }),
    ).toBeUndefined();
  });
});

describe("checksPath", () => {
  it("names the deployment's history", () => {
    expect(checksPath("org-1", "dep-1")).toBe(
      "/dashboard/org-1/deployments/dep-1/checks",
    );
  });

  it("carries a cursor in a form a URL survives", () => {
    // The cursor is a timestamp with a `+00:00` offset, whose `+` and `:`
    // would otherwise be read as a space and a delimiter.
    expect(checksPath("org-1", "dep-1", "2026-09-27T00:00:00+00:00")).toBe(
      "/dashboard/org-1/deployments/dep-1/checks?before=2026-09-27T00%3A00%3A00%2B00%3A00",
    );
  });
});
