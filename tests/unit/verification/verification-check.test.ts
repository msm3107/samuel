import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  serializeVerificationCheck,
  VERIFICATION_FAILURE_CODES,
  VERIFICATION_STATUSES,
  verificationCheckRowSchema,
} from "@/features/verification/verification-check";

/**
 * The verification codes (TASK-022) are written out twice: here and in the
 * migrations' `verification_checks_failure_code_check`. This keeps them
 * equal, as tests/unit/disclosures/languages.test.ts does for the
 * languages.
 *
 * It covers the direction the real-database suite cannot: a code the
 * database accepts that the application has never heard of. The other
 * direction — a code the application knows that the database refuses — is
 * exercised against the live constraint in
 * tests/security/verification/verification-checks-isolation.supabase.ts.
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
function databaseFailureCodes(): string[] {
  const pattern =
    /verification_checks_failure_code_check check \(\s*failure_code in \(([\s\S]*?)\)\s*\)/g;
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

const row = {
  id: "00000000-0000-4000-8000-000000000001",
  organization_id: "00000000-0000-4000-8000-000000000002",
  deployment_id: "00000000-0000-4000-8000-000000000003",
  disclosure_id: "00000000-0000-4000-8000-000000000004",
  status: "success",
  failure_code: null,
  checked_at: "2026-09-26T10:00:00+00:00",
  check_window: "2026-09-26T00:00:00+00:00",
  http_status: 200,
  widget_detected: true,
  disclosure_version: 3,
  metadata: {},
  payload_hash: null,
  previous_record_hash: null,
};

describe("VERIFICATION_FAILURE_CODES", () => {
  it("matches the database's constraint", () => {
    expect([...VERIFICATION_FAILURE_CODES].sort()).toEqual(
      databaseFailureCodes().sort(),
    );
  });

  it("is a set of machine-readable codes, and excludes SUCCESS", () => {
    expect(new Set(VERIFICATION_FAILURE_CODES).size).toBe(
      VERIFICATION_FAILURE_CODES.length,
    );
    for (const code of VERIFICATION_FAILURE_CODES) {
      expect(code).toMatch(/^[A-Z][A-Z_]*[A-Z]$/);
    }
    // `status` already says a check succeeded (owner, 2026-09-26).
    expect(VERIFICATION_FAILURE_CODES as readonly string[]).not.toContain(
      "SUCCESS",
    );
    expect(VERIFICATION_STATUSES).toEqual(["success", "failure"]);
  });
});

describe("a verification check row", () => {
  it("refuses a success carrying a reason, and a failure without one", () => {
    expect(
      verificationCheckRowSchema.safeParse({
        ...row,
        failure_code: "DNS_ERROR",
      }).success,
    ).toBe(false);
    expect(
      verificationCheckRowSchema.safeParse({ ...row, status: "failure" })
        .success,
    ).toBe(false);
    expect(
      verificationCheckRowSchema.safeParse({
        ...row,
        status: "failure",
        failure_code: "DNS_ERROR",
      }).success,
    ).toBe(true);
  });

  it("refuses a digest that is not 64 lowercase hex characters", () => {
    for (const wrong of ["a".repeat(63), "A".repeat(64), "g".repeat(64), ""]) {
      expect(
        verificationCheckRowSchema.safeParse({ ...row, payload_hash: wrong })
          .success,
      ).toBe(false);
    }
    expect(
      verificationCheckRowSchema.safeParse({
        ...row,
        payload_hash: "a".repeat(64),
        previous_record_hash: "b".repeat(64),
      }).success,
    ).toBe(true);
  });

  it("serializes without the organization, the disclosure or the metadata", () => {
    const serialized = serializeVerificationCheck({
      ...row,
      metadata: { redirects: 2 },
    });

    expect(serialized).toEqual({
      id: row.id,
      deploymentId: row.deployment_id,
      status: "success",
      failureCode: null,
      checkedAt: row.checked_at,
      checkWindow: row.check_window,
      httpStatus: 200,
      widgetDetected: true,
      disclosureVersion: 3,
    });
    const keys = Object.keys(serialized);
    expect(keys).not.toContain("organizationId");
    expect(keys).not.toContain("disclosureId");
    expect(keys).not.toContain("metadata");
  });
});
