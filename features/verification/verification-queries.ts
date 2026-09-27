import "server-only";

import { z } from "zod";

import {
  VERIFICATION_FAILURE_CODES,
  type VerificationMetadata,
} from "@/features/verification/verification-check";
import { createServiceRoleClient } from "@/lib/database/service-role-client";
import { PUBLIC_DEPLOYMENT_ID_PATTERN } from "@/lib/security/public-id";

/**
 * The scheduler's two database calls (TASK-025): read the queue, write a row.
 *
 * Both use the service-role client, which is what this client exists for —
 * work no signed-in user can perform on their own behalf. A member must not be
 * able to produce their own compliance evidence, which is why TASK-022 gave
 * `authenticated` no insert grant and wrote no insert policy; the queue
 * crosses every tenant boundary by design, which is why its function is
 * executable by `service_role` alone.
 *
 * Nothing here decides *which* deployments are due. That predicate lives in
 * `public.verification_queue`, beside the one `public.public_disclosure`
 * applies, so the set this checks and the set the widget serves cannot drift
 * apart.
 */

/** A deployment the run should check, as the queue function returns it. */
export const verificationQueueRowSchema = z.strictObject({
  organization_id: z.uuid(),
  deployment_id: z.uuid(),
  disclosure_id: z.uuid(),
  // The same bound the `deployments_hostname_check` constraint applies.
  hostname: z.string().min(1).max(253),
  public_id: z.string().regex(PUBLIC_DEPLOYMENT_ID_PATTERN),
});

export type VerificationQueueRow = Readonly<
  z.infer<typeof verificationQueueRowSchema>
>;

/**
 * Strict, and an array: a column added to the function's return type reaches
 * no further than this schema, and a shape the application cannot read is a
 * fault of ours rather than something to guess at.
 */
const verificationQueueSchema = z.array(verificationQueueRowSchema);

/** What one finished check has to say, before it becomes a row. */
export type VerificationCheckRecord = Readonly<{
  organizationId: string;
  deploymentId: string;
  disclosureId: string;
  checkWindow: Date;
  status: "success" | "failure";
  failureCode: (typeof VERIFICATION_FAILURE_CODES)[number] | null;
  httpStatus: number | null;
  widgetDetected: boolean | null;
  metadata: VerificationMetadata;
}>;

/**
 * The database refused in a way no correct run should cause. Kept as its own
 * error so the route can tell "the database is unavailable" from "this
 * application sent something the table refuses", which are a retry and a bug
 * respectively.
 */
export class VerificationQueryError extends Error {
  override readonly name = "VerificationQueryError";

  constructor(
    readonly databaseCode: string | undefined,
    options?: ErrorOptions,
  ) {
    super("A verification query failed", options);
  }
}

/** The function answered a shape this application cannot read. */
export class VerificationQueueShapeError extends Error {
  override readonly name = "VerificationQueueShapeError";

  constructor(options?: ErrorOptions) {
    super("The verification queue answered an unreadable shape", options);
  }
}

/**
 * The deployments due for a check in `checkWindow`, at most `limit` of them.
 *
 * Not a claim: nothing is marked, and two overlapping runs can be handed the
 * same deployment. The second insert loses at
 * `unique (deployment_id, check_window)`, which is the failure mode TASK-022
 * chose that key to have — a duplicate fetch is wasteful, a duplicate row
 * would be a lie about how often we looked.
 */
export async function readVerificationQueue(
  checkWindow: Date,
  limit: number,
): Promise<readonly VerificationQueueRow[]> {
  const { data, error } = await createServiceRoleClient().rpc(
    "verification_queue",
    { p_check_window: checkWindow.toISOString(), p_limit: limit },
  );

  if (error) {
    throw new VerificationQueryError(error.code, { cause: error });
  }

  const parsed = verificationQueueSchema.safeParse(data ?? []);
  if (!parsed.success) {
    throw new VerificationQueueShapeError({ cause: parsed.error });
  }
  return Object.freeze(parsed.data);
}

/**
 * Writes one check.
 *
 * `checked_at` is deliberately not sent: TASK-022's trigger sets it from the
 * database's clock, because a job's clock is not evidence. `payload_hash` and
 * `previous_record_hash` are not sent either — §20's chain is still unwritten,
 * and this is the task whose first run starts the gap README §20 records.
 * `disclosure_version` is never sent, because HTML inspection cannot observe
 * one (TASK-024).
 *
 * A duplicate is not an error the caller has to reason about: the unique
 * violation means another tick of this window already recorded this
 * deployment, which is the idempotency working. It returns `false` rather than
 * throwing, so a run can count it and move on.
 */
export async function recordVerificationCheck(
  record: VerificationCheckRecord,
): Promise<boolean> {
  const { error } = await createServiceRoleClient()
    .from("verification_checks")
    .insert({
      organization_id: record.organizationId,
      deployment_id: record.deploymentId,
      disclosure_id: record.disclosureId,
      check_window: record.checkWindow.toISOString(),
      status: record.status,
      failure_code: record.failureCode,
      http_status: record.httpStatus,
      widget_detected: record.widgetDetected,
      metadata: record.metadata,
    });

  if (!error) {
    return true;
  }
  // 23505: unique_violation, and this table has exactly one unique constraint
  // that a run can hit.
  if (error.code === "23505") {
    return false;
  }
  throw new VerificationQueryError(error.code, { cause: error });
}
