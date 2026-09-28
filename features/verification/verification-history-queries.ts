import "server-only";

import { z } from "zod";

import {
  DEPLOYMENT_STATUSES,
  type DeploymentStatus,
} from "@/features/deployments/deployment";
import {
  serializeVerificationCheck,
  type SerializedVerificationCheck,
} from "@/features/verification/verification-check";
import { AuthorizationError } from "@/lib/auth/errors";
import {
  minimumRoleFor,
  roleSatisfies,
  type OrganizationPermission,
} from "@/lib/auth/organization-roles";
import type { OrganizationAccess } from "@/lib/auth/require-organization-role";
import { createResolvingSessionClient } from "@/lib/database/session-client";

/**
 * Reading a deployment's verification history (TASK-026; README §18-§20).
 *
 * The other side of Phase 7: the scheduler writes with the service-role client
 * because no signed-in user may produce their own evidence, and **this module
 * reads with the session client, under row-level security**. It does not import
 * the service-role client at all, and it must not: a read a member is entitled
 * to is a read the session client can serve, which is the rule §16 and the
 * client boundary exist for.
 *
 * `verification_checks_select_member` (TASK-022) admits every member of a live
 * organization, viewers included — evidence is the thing customers rely on, so
 * a viewer may read it. `organization.read` is still asserted first, so the
 * application refuses before the database has to.
 *
 * Nothing here can change a row. The table has no update or delete grant for
 * any role and a trigger refuses both regardless; this module only selects.
 */

/** Past this, a page is cut short and says so, as for every other list. */
export const VERIFICATION_LIST_LIMIT = 200;

/** Where a page starts. Absent means the newest checks. */
export type VerificationHistoryPage = Readonly<{ before?: Date }>;

export type VerificationHistory = Readonly<{
  /**
   * The deployment's own status, so a screen can say whether it is reading an
   * archived deployment's history — which stays readable, because TASK-022
   * keeps its evidence. It rides along on the query that was needed anyway
   * rather than costing a second round trip for one column.
   */
  deploymentStatus: DeploymentStatus;
  /** Newest first. At most {@link VERIFICATION_LIST_LIMIT} of them. */
  checks: SerializedVerificationCheck[];
  /**
   * More checks exist below the last one here. No cursor is returned with it:
   * the caller asks again with the last row's `checkWindow`, which is the rule
   * README §31 documents for both paged endpoints.
   */
  truncated: boolean;
}>;

/**
 * A proof of access for a lower role must not be reused for a higher one, as in
 * the other feature query modules. Written out here rather than shared, because
 * each of them keeps its own copy and moving them all is not this task's.
 */
function assertAccessAllows(
  access: OrganizationAccess,
  permission: OrganizationPermission,
): void {
  if (!roleSatisfies(access.role, minimumRoleFor(permission))) {
    throw new AuthorizationError();
  }
}

/** The database refused in a way no validated request should cause. */
export class VerificationHistoryQueryError extends Error {
  override readonly name = "VerificationHistoryQueryError";

  constructor(
    readonly databaseCode: string | undefined,
    options?: ErrorOptions,
  ) {
    super("A verification history could not be read", options);
  }
}

/** The columns the serializer needs, and no others. */
const CHECK_COLUMNS = [
  "id",
  "organization_id",
  "deployment_id",
  "disclosure_id",
  "status",
  "failure_code",
  "checked_at",
  "check_window",
  "http_status",
  "widget_detected",
  "disclosure_version",
  "metadata",
  "payload_hash",
  "previous_record_hash",
].join(", ");

/**
 * The shape the embed returns. Validated because the database is external input
 * like any other: a column added to the table reaches no caller until the row
 * schema says so.
 */
const historyRowSchema = z.object({
  status: z.enum(DEPLOYMENT_STATUSES),
  verification_checks: z.array(z.unknown()),
});

/**
 * One deployment's checks, newest first, or null when this organization has no
 * such deployment.
 *
 * Null rather than an empty page on purpose: the query reads from `deployments`
 * and embeds the checks, so "no such deployment" and "a deployment with no
 * checks yet" are different answers. A screen needs to tell them apart, and a
 * query against `verification_checks` alone would answer `[]` to both. Another
 * organization's deployment is the first case, so it is a 404 — it says nothing
 * about whether that deployment exists.
 *
 * @param page `before` is a `check_window`; the page holds the checks in
 *   windows strictly before it.
 */
export async function listVerificationChecks(
  access: OrganizationAccess,
  deploymentId: string,
  page: VerificationHistoryPage = {},
): Promise<VerificationHistory | null> {
  assertAccessAllows(access, "organization.read");
  const { supabase } = await createResolvingSessionClient();

  // One more than the page, to know whether there are more without a count.
  const query = supabase
    .from("deployments")
    .select(
      `status, verification_checks!verification_checks_deployment_fkey(${CHECK_COLUMNS})`,
    )
    .eq("organization_id", access.organizationId)
    .eq("id", deploymentId)
    .order("check_window", {
      referencedTable: "verification_checks",
      ascending: false,
    })
    .limit(VERIFICATION_LIST_LIMIT + 1, {
      referencedTable: "verification_checks",
    });

  // Filters the embedded checks, not the deployment: a deployment with no
  // check below the cursor is still found, with an empty page.
  const { data, error } = await (
    page.before === undefined
      ? query
      : query.lt("verification_checks.check_window", page.before.toISOString())
  ).maybeSingle();

  if (error) {
    throw new VerificationHistoryQueryError(error.code, { cause: error });
  }
  if (data === null) {
    return null;
  }

  const parsed = historyRowSchema.parse(data);
  return {
    deploymentStatus: parsed.status,
    checks: parsed.verification_checks
      .slice(0, VERIFICATION_LIST_LIMIT)
      .map(serializeVerificationCheck),
    truncated: parsed.verification_checks.length > VERIFICATION_LIST_LIMIT,
  };
}

/**
 * The newest check for one deployment, or null when the deployment has none —
 * and null too when this organization has no such deployment (TASK-027).
 *
 * Those two are one answer here, deliberately, and it is the opposite choice
 * from {@link listVerificationChecks}: this serves a summary on a page that has
 * already found the deployment and already said so, so it has nothing to tell
 * apart. Where the difference matters, the list is what answers.
 *
 * A read of its own rather than a page of 200 dropped down to one. It is the
 * same order and the same index — `(deployment_id, check_window)` — so the
 * newest row here is the first row there.
 */
export async function readLatestVerificationCheck(
  access: OrganizationAccess,
  deploymentId: string,
): Promise<SerializedVerificationCheck | null> {
  assertAccessAllows(access, "organization.read");
  const { supabase } = await createResolvingSessionClient();

  const { data, error } = await supabase
    .from("verification_checks")
    .select(CHECK_COLUMNS)
    .eq("organization_id", access.organizationId)
    .eq("deployment_id", deploymentId)
    .order("check_window", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw new VerificationHistoryQueryError(error.code, { cause: error });
  }
  return data === null ? null : serializeVerificationCheck(data);
}
