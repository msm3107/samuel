import { z } from "zod";

/**
 * A verification check (TASK-022): append-only evidence that a deployment
 * was checked (README §18-§20).
 *
 * Nothing imports this yet. TASK-023 fetches, TASK-024 maps a failure to
 * one of the codes below, TASK-025 schedules. The schema landed first,
 * because a migration adding something the application reads ships before
 * the code that reads it.
 *
 * The lists here are written out a second time in
 * `supabase/migrations/20260926120000_verification_checks.sql`; the
 * real-database test reads the live constraint and keeps the two equal, so
 * a code added in one place and forgotten in the other fails there rather
 * than at the first check that needed it.
 */

/** README §5: a check succeeded or it did not. */
export const VERIFICATION_STATUSES = ["success", "failure"] as const;

export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/**
 * Why a check failed (README §19). Deterministic and machine-readable:
 * application logic reads these, never a human-readable string.
 *
 * `SUCCESS` is deliberately absent. `status` already says a check
 * succeeded, and a second encoding of one fact is a second thing that can
 * be wrong — so a stored code means a failure, always (owner, 2026-09-26).
 *
 * `TOTAL_TIMEOUT` and `TOO_MANY_REDIRECTS` are not in §19's example list.
 * Phase 7 requires each exceeded bound to map to its own code, and a
 * connection that never opened is a different fact from one that opened and
 * never finished.
 */
export const VERIFICATION_FAILURE_CODES = [
  "DNS_ERROR",
  "CONNECTION_TIMEOUT",
  "TOTAL_TIMEOUT",
  "HTTP_ERROR",
  "REDIRECT_BLOCKED",
  "TOO_MANY_REDIRECTS",
  "PRIVATE_NETWORK_BLOCKED",
  "RESPONSE_TOO_LARGE",
  "WIDGET_NOT_FOUND",
  "DEPLOYMENT_ID_MISMATCH",
  "DISCLOSURE_VERSION_MISMATCH",
  "UNKNOWN_ERROR",
] as const;

export type VerificationFailureCode =
  (typeof VERIFICATION_FAILURE_CODES)[number];

/** A SHA-256 digest as §20's chain would store it, if it stored one. */
const digest = z.string().regex(/^[0-9a-f]{64}$/);

const timestamp = z.iso.datetime({ offset: true });

/**
 * One row as the database returns it. The shape mirrors the table, with
 * the same rule tying the two outcome columns together: a success carries
 * no reason and a failure always carries one.
 */
export const verificationCheckRowSchema = z
  .object({
    id: z.uuid(),
    organization_id: z.uuid(),
    deployment_id: z.uuid(),
    disclosure_id: z.uuid(),
    status: z.enum(VERIFICATION_STATUSES),
    failure_code: z.enum(VERIFICATION_FAILURE_CODES).nullable(),
    checked_at: timestamp,
    check_window: timestamp,
    http_status: z.int().min(100).max(599).nullable(),
    widget_detected: z.boolean().nullable(),
    // What was observed on the page, not what was expected: disclosure_id
    // names the expected version.
    disclosure_version: z.int().min(1).nullable(),
    metadata: z.record(z.string(), z.unknown()),
    payload_hash: digest.nullable(),
    previous_record_hash: digest.nullable(),
  })
  .refine((row) => (row.status === "success") === (row.failure_code === null), {
    message: "a success carries no failure code, and a failure carries one",
  });

export type VerificationCheckRow = z.infer<typeof verificationCheckRowSchema>;

export type SerializedVerificationCheck = Readonly<{
  id: string;
  deploymentId: string;
  status: VerificationStatus;
  failureCode: VerificationFailureCode | null;
  checkedAt: string;
  checkWindow: string;
  httpStatus: number | null;
  widgetDetected: boolean | null;
  disclosureVersion: number | null;
}>;

/**
 * What leaves this feature. No organization id, no disclosure id, no
 * metadata: a screen shows what happened, and the identifiers it already
 * has are the ones it navigated by (README §31).
 */
export function serializeVerificationCheck(
  row: unknown,
): SerializedVerificationCheck {
  const parsed = verificationCheckRowSchema.parse(row);
  return Object.freeze({
    id: parsed.id,
    deploymentId: parsed.deployment_id,
    status: parsed.status,
    failureCode: parsed.failure_code,
    checkedAt: parsed.checked_at,
    checkWindow: parsed.check_window,
    httpStatus: parsed.http_status,
    widgetDetected: parsed.widget_detected,
    disclosureVersion: parsed.disclosure_version,
  });
}
