import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { serializeVerificationCheck } from "@/features/verification/verification-check";
import * as history from "@/features/verification/verification-history-queries";
import * as queries from "@/features/verification/verification-queries";

/**
 * What the history feature exposes, and what it does not (TASK-026).
 *
 * Two properties that are easy to lose later and cheap to pin now: nothing
 * about a check leaves the server except the serializer's fields, and this
 * read path has no writer and no service-role client in it.
 *
 * There is deliberately no test for "a role below `organization.read`":
 * `organization.read` maps to `viewer`, the lowest role there is, so such a
 * test could not fail. The boundary that *can* fail is the tenant one, and it
 * needs real row-level security — it is in
 * `tests/integration/verification/verification-history.supabase.ts`.
 */

const row = {
  id: "00000000-0000-4000-8000-000000000001",
  organization_id: "00000000-0000-4000-8000-000000000002",
  deployment_id: "00000000-0000-4000-8000-000000000003",
  disclosure_id: "00000000-0000-4000-8000-000000000004",
  status: "failure",
  failure_code: "WIDGET_NOT_FOUND",
  checked_at: "2026-09-27T09:00:00.000Z",
  check_window: "2026-09-27T00:00:00.000Z",
  http_status: 200,
  widget_detected: false,
  disclosure_version: null,
  metadata: {
    widget_tags: 0,
    widget_reason: "FOREIGN_ORIGIN",
    final_host: "shop.example.com",
    charset: "utf-8",
  },
  payload_hash: null,
  previous_record_hash: null,
};

describe("what leaves the server", () => {
  it("does not include metadata, on a failure that has plenty of it", () => {
    // `metadata` is ours, for support. The screen shows the failure code; the
    // reason a check failed is not withheld, but the facts we collected about
    // the attempt are not a customer-facing surface (README §31, §34).
    const serialized = serializeVerificationCheck(row);

    expect(Object.keys(serialized)).not.toContain("metadata");
    expect(JSON.stringify(serialized)).not.toContain("shop.example.com");
    expect(JSON.stringify(serialized)).not.toContain("FOREIGN_ORIGIN");
  });

  it("does not include the organization or the disclosure it was checked against", () => {
    const keys = Object.keys(serializeVerificationCheck(row));

    expect(keys).not.toContain("organizationId");
    expect(keys).not.toContain("disclosureId");
  });

  it("does include what a reader needs to page and to judge", () => {
    const serialized = serializeVerificationCheck(row);

    expect(Object.keys(serialized).sort()).toEqual([
      "checkWindow",
      "checkedAt",
      "deploymentId",
      "disclosureVersion",
      "failureCode",
      "httpStatus",
      "id",
      "status",
      // README §18's second question, which is the one an inspection can
      // answer: was Article50.js present.
      "widgetDetected",
    ]);
    // The cursor a truncated page is continued with is in the rows themselves,
    // which is what lets the response carry no cursor of its own.
    expect(serialized.checkWindow).toBe("2026-09-27T00:00:00.000Z");
  });

  it("refuses a row that claims a version an inspection cannot observe", () => {
    // Not this module's rule, but worth pinning where the history reads it: a
    // success must have been a response with the widget found.
    expect(() =>
      serializeVerificationCheck({
        ...row,
        status: "success",
        failure_code: null,
        widget_detected: false,
      }),
    ).toThrow();
  });
});

describe("what this feature can do", () => {
  it("offers a read and nothing else", () => {
    // Evidence is append-only. No route, service or screen may offer an update
    // or a delete of a check, and the table grants neither to any role.
    //
    // Asserted as "no export is named like a writer" rather than as an exact
    // list, so that adding a second *read* does not fail this while adding a
    // write still does.
    const writerish = Object.keys(history).filter((name) =>
      /record|insert|update|delete|write|remove|save/i.test(name),
    );

    expect(writerish).toEqual([]);
    expect(Object.keys(history)).toContain("listVerificationChecks");
  });

  it("keeps the writer's service-role queries in a different module", () => {
    // The scheduler writes with the service-role client because no signed-in
    // user may produce their own evidence; a member's read is a read the
    // session client can serve. Two modules, so neither can drift into the
    // other's client.
    expect(Object.keys(queries)).toContain("recordVerificationCheck");
    expect(Object.keys(history)).not.toContain("recordVerificationCheck");
  });
});
