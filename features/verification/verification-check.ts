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
 *
 * `CONNECTION_FAILED` is added in TASK-023, and it is the one code here that
 * is not about a bound. The name resolved and the connection was refused,
 * reset, unreachable, or rejected at TLS — a site that is simply down, which
 * is the most common real failure there is. Without it that lands on
 * `UNKNOWN_ERROR`, which tells a customer nothing and is exactly what §19
 * exists to prevent. Proposed by the implementer, awaiting sign-off.
 */
export const VERIFICATION_FAILURE_CODES = [
  "DNS_ERROR",
  "CONNECTION_FAILED",
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

/**
 * What `metadata` may hold: facts about the check, never content from the
 * customer's page (owner, 2026-09-26; README §34).
 *
 * From TASK-023 this is a whitelist rather than a habit. The same key names
 * are written out in
 * `supabase/migrations/20260927100000_verification_metadata_keys.sql`, where
 * a check constraint refuses anything else, and a unit test keeps the two
 * equal in both directions. The strictness is the point: a page excerpt fits
 * comfortably inside the 2048-byte size cap TASK-022 set, so size was never
 * what stopped page content getting in (PR #39 review, note 4).
 *
 * Every key is optional, because a check that failed at DNS observed none of
 * them. TASK-024 adds the inspection keys — which matcher failed, and what
 * it looked for — in its own migration.
 *
 * The reviewer's own limitation is worth repeating here, where a future
 * writer will meet it: a whitelist bounds keys, not values. Nothing stops a
 * caller putting a page excerpt in `content_type`; what it stops is a new
 * key nobody reviewed.
 */
const REDIRECT_REASONS = [
  "INVALID_LOCATION",
  "UNSUPPORTED_SCHEME",
  "SCHEME_DOWNGRADE",
  "EMBEDDED_CREDENTIALS",
  "PRIVATE_NETWORK_BLOCKED",
  "IP_ADDRESS_NOT_ALLOWED",
  "PORT_NOT_ALLOWED",
] as const;

export const verificationMetadataSchema = z.strictObject({
  /** Which scheme answered. Plain HTTP is weaker evidence, so it is stored. */
  scheme: z.enum(["https", "http"]).optional(),
  /** Whether HTTPS was tried first and failed (owner, 2026-09-27). */
  https_failed: z.boolean().optional(),
  /** How many hops were followed. */
  redirects: z.int().min(0).optional(),
  /** The hostname the body came from, which a chain may have changed. */
  final_host: z.string().max(253).optional(),
  /** Bytes of body read, after decompression. */
  response_bytes: z.int().min(0).optional(),
  /** How long the whole attempt took, including any HTTPS attempt. */
  duration_ms: z.int().min(0).optional(),
  /** The `Content-Type` header as given, so a PDF home page is explicable. */
  content_type: z.string().max(256).optional(),
  /**
   * Which of the seven redirect rules refused a hop (PR #40 review, note 2).
   * `REDIRECT_BLOCKED` is one stored code over six causes that need six
   * different fixes — a stray `ftp://`, a `:8443`, credentials in a
   * `Location`, a bare IP, a malformed header, a downgrade — and this is the
   * one failure class the customer must act on. §19 governs `failure_code`,
   * not `metadata`, and six more top-level codes would force every consumer
   * of that list to handle a detail about one code.
   *
   * Storing it is privacy-safe by construction rather than by care:
   * `REDIRECT_REFUSALS` is a fixed list of seven strings with no customer
   * data in it. The constraint bounds the key; the enum here bounds the
   * value, which the migration deliberately does not try to do.
   *
   * The seven values are written out again below rather than imported from
   * `lib/security/verification-target`, which is `server-only`: this module is
   * a row shape, and a Phase 8 screen may need it. A unit test keeps the two
   * lists equal, which is what this repository already does for the failure
   * codes and the migration.
   */
  redirect_reason: z.enum(REDIRECT_REASONS).optional(),
});

export type VerificationMetadata = z.infer<typeof verificationMetadataSchema>;

/** The keys the constraint allows, for the test that compares the two. */
export const VERIFICATION_METADATA_KEYS = Object.freeze(
  Object.keys(verificationMetadataSchema.shape).sort(),
);

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
    metadata: verificationMetadataSchema,
    payload_hash: digest.nullable(),
    previous_record_hash: digest.nullable(),
  })
  .refine((row) => (row.status === "success") === (row.failure_code === null), {
    message: "a success carries no failure code, and a failure carries one",
  })
  .refine(
    // The database's other coherence rule, mirrored: a success means a body
    // was fetched and the widget was found, so it cannot contradict its own
    // observations (owner, 2026-09-26). The observed version stays free —
    // the widget can be found without a readable version beside it.
    (row) =>
      row.status !== "success" ||
      (row.http_status !== null && row.widget_detected === true),
    { message: "a success means a response arrived and the widget was found" },
  );

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
