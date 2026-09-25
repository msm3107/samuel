import { describe, expect, it } from "vitest";

import {
  DISCLOSURE_FORM_MESSAGES,
  disclosurePath,
  FIELD_MESSAGES,
  isProblem,
  type DisclosureFormResult,
} from "@/app/(dashboard)/dashboard/[organizationId]/systems/[systemId]/disclosure/messages";
import { DISCLOSURE_FORM_FIELDS } from "@/features/disclosures/disclosure-fields";
import type { PublishDisclosureResult } from "@/features/disclosures/disclosure-queries";

/**
 * The disclosure editor's fixed text (TASK-018): every result the action can
 * return has something to show, every invalid field has its own message, and
 * the "problem" marker is true for everything but a successful publish.
 */

describe("DISCLOSURE_FORM_MESSAGES", () => {
  it.each(Object.keys(DISCLOSURE_FORM_MESSAGES) as DisclosureFormResult[])(
    "has non-empty text for %s",
    (result) => {
      expect(DISCLOSURE_FORM_MESSAGES[result].length).toBeGreaterThan(0);
    },
  );

  /**
   * Every refusal `publishDisclosure` (the query layer) can hand back, apart
   * from `ok`, must be a key here with real text: this record's type only
   * type-checks if its keys are exactly that union, so a new refusal added
   * to the query layer and forgotten here fails `pnpm typecheck`, not just
   * this test.
   */
  const NON_OK_QUERY_STATUS_MESSAGES: Record<
    Exclude<PublishDisclosureResult["status"], "ok">,
    string
  > = {
    disclosure_changed: DISCLOSURE_FORM_MESSAGES.disclosure_changed,
    disclosure_unchanged: DISCLOSURE_FORM_MESSAGES.disclosure_unchanged,
    ai_system_archived: DISCLOSURE_FORM_MESSAGES.ai_system_archived,
    ai_system_not_found: DISCLOSURE_FORM_MESSAGES.ai_system_not_found,
  };

  it("every non-ok query status is a key of DISCLOSURE_FORM_MESSAGES, with real text", () => {
    for (const [status, text] of Object.entries(NON_OK_QUERY_STATUS_MESSAGES)) {
      expect(Object.keys(DISCLOSURE_FORM_MESSAGES)).toContain(status);
      expect(text.length).toBeGreaterThan(0);
    }
  });
});

describe("FIELD_MESSAGES", () => {
  it.each(DISCLOSURE_FORM_FIELDS)("has a message for the %s field", (field) => {
    expect(FIELD_MESSAGES[field].length).toBeGreaterThan(0);
  });

  it("has a message for every field and nothing else", () => {
    expect(Object.keys(FIELD_MESSAGES).sort()).toEqual(
      [...DISCLOSURE_FORM_FIELDS].sort(),
    );
  });
});

describe("isProblem", () => {
  it("is false only for published", () => {
    expect(isProblem("published")).toBe(false);
    for (const result of Object.keys(
      DISCLOSURE_FORM_MESSAGES,
    ) as DisclosureFormResult[]) {
      if (result === "published") {
        continue;
      }
      expect(isProblem(result)).toBe(true);
    }
  });
});

describe("disclosurePath", () => {
  it("builds the path from the organization and system IDs", () => {
    const organizationId = "0f6b2a4c-8d1e-4f3a-9b5c-6e7d8a9b0c1d";
    const systemId = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

    expect(disclosurePath(organizationId, systemId)).toBe(
      `/dashboard/${organizationId}/systems/${systemId}/disclosure`,
    );
  });
});

describe("disclosurePath with a cursor (TASK-018a)", () => {
  const organizationId = "0f6b2a4c-8d1e-4f3a-9b5c-6e7d8a9b0c1d";
  const systemId = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

  it("adds before as the only query parameter", () => {
    expect(disclosurePath(organizationId, systemId, 201)).toBe(
      `/dashboard/${organizationId}/systems/${systemId}/disclosure?before=201`,
    );
  });

  it("leaves the path alone when there is no cursor", () => {
    expect(disclosurePath(organizationId, systemId, undefined)).toBe(
      disclosurePath(organizationId, systemId),
    );
  });
});
