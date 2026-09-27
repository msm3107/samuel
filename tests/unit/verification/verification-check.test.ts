import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  serializeVerificationCheck,
  VERIFICATION_FAILURE_CODES,
  VERIFICATION_METADATA_KEYS,
  VERIFICATION_STATUSES,
  verificationCheckRowSchema,
  verificationMetadataSchema,
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

/**
 * The key list in the latest migration that defines the whitelist. SQL
 * comments are stripped first, so a comment that happens to contain a quote
 * cannot be read as a key.
 */
function databaseMetadataKeys(): string[] {
  const pattern =
    /verification_checks_metadata_keys_check check \(([\s\S]*?)\s\);/g;
  const blocks = readdirSync(MIGRATIONS_DIRECTORY)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .flatMap((file) => [
      ...readFileSync(join(MIGRATIONS_DIRECTORY, file), "utf8").matchAll(
        pattern,
      ),
    ])
    .map((match) => match[1] ?? "");
  expect(blocks.length).toBeGreaterThan(0);

  const sql = (blocks.at(-1) ?? "")
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, ""))
    .join(" ");
  // Only the keys the array names. The `jsonb_typeof(metadata) <> 'object'`
  // guard in front of it is a type check, not a key.
  const keys = /array\[([^\]]*)\]/.exec(sql)?.[1] ?? "";
  return [...keys.matchAll(/'([a-z_]+)'/g)].map((match) => match[1] ?? "");
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

  it("refuses a success that contradicts its own observations", () => {
    for (const contradiction of [
      { widget_detected: false },
      { http_status: null },
      { widget_detected: null },
    ]) {
      expect(
        verificationCheckRowSchema.safeParse({ ...row, ...contradiction })
          .success,
      ).toBe(false);
    }
    // A failure may have observed anything, or nothing.
    expect(
      verificationCheckRowSchema.safeParse({
        ...row,
        status: "failure",
        failure_code: "WIDGET_NOT_FOUND",
        widget_detected: false,
      }).success,
    ).toBe(true);
    // And the observed version stays free on a success.
    expect(
      verificationCheckRowSchema.safeParse({ ...row, disclosure_version: null })
        .success,
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

describe("VERIFICATION_METADATA_KEYS", () => {
  it("is exactly the whitelist the database enforces", () => {
    // PR #39 review, note 4: `metadata`'s promise stopped being a
    // code-review promise in TASK-023. Both directions matter — a key the
    // schema knows that the constraint refuses would fail every write, and a
    // key the constraint allows that the schema has never heard of is a key
    // nobody reviewed.
    expect([...VERIFICATION_METADATA_KEYS]).toEqual(
      databaseMetadataKeys().sort(),
    );
  });

  it("refuses a key nobody put on the list", () => {
    const parsed = verificationMetadataSchema.safeParse({
      scheme: "https",
      page_excerpt: "<html>…</html>",
    });

    expect(parsed.success).toBe(false);
  });

  it("accepts every key a check can produce, and an empty object", () => {
    expect(
      verificationMetadataSchema.safeParse({
        // The transport's (TASK-023).
        scheme: "http",
        https_failed: true,
        redirects: 2,
        final_host: "www.example.com",
        response_bytes: 4096,
        duration_ms: 812,
        content_type: "text/html; charset=utf-8",
        redirect_reason: "SCHEME_DOWNGRADE",
        // The inspection's (TASK-024).
        charset: "windows-1252",
        widget_tags: 1,
        widget_reason: "FOREIGN_ORIGIN",
      }).success,
    ).toBe(true);
    // A check that failed at DNS observed none of them.
    expect(verificationMetadataSchema.safeParse({}).success).toBe(true);
  });

  it("refuses a widget reason nobody defined", () => {
    expect(
      verificationMetadataSchema.safeParse({ widget_reason: "LOOKS_FINE" })
        .success,
    ).toBe(false);
  });

  it("refuses a negative tag count", () => {
    expect(
      verificationMetadataSchema.safeParse({ widget_tags: -1 }).success,
    ).toBe(false);
  });

  it("refuses a row whose metadata carries an unknown key", () => {
    expect(
      verificationCheckRowSchema.safeParse({
        ...row,
        metadata: { redirects: 1, body: "<html>" },
      }).success,
    ).toBe(false);
  });
});
