import { z } from "zod";

import type { VerificationTargetFailure } from "@/lib/security/verification-target";

/**
 * Deployment input rules and response shape (TASK-013). The hostname's
 * rules are not here: `validateVerificationTarget` (TASK-012) is the one
 * check, and the route calls it on what this schema lets through.
 */

export const DEPLOYMENT_STATUSES = ["active", "archived"] as const;

export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

/**
 * A new deployment (README §14). Strict: the organization comes from the
 * route, the status starts `active`, and the ID and timestamps are the
 * database's, so a body naming any of them is refused rather than trimmed.
 *
 * The hostname is only bounded here, as a string no longer than the
 * validator reads; whether it is a safe target is TASK-012's to say, with
 * its own code.
 */
export const createDeploymentSchema = z.strictObject({
  aiSystemId: z.uuid(),
  hostname: z.string().max(1024),
});

export type CreateDeploymentInput = z.infer<typeof createDeploymentSchema>;

/**
 * A change: archive or restore. The hostname and AI system never change
 * (TASK-011, owner's decision); to move a deployment, archive it and
 * register again.
 */
export const updateDeploymentSchema = z.strictObject({
  status: z.enum(DEPLOYMENT_STATUSES),
});

export type UpdateDeploymentInput = z.infer<typeof updateDeploymentSchema>;

/** `?status=` on the list: active by default. */
export const deploymentListFilterSchema = z
  .enum([...DEPLOYMENT_STATUSES, "all"])
  .default("active");

export type DeploymentListFilter = z.infer<typeof deploymentListFilterSchema>;

/**
 * The API code for each reason TASK-012 refuses a hostname (owner's
 * decision, 2026-09-22): one each, so a form can say what to fix. None
 * reveals anything the person didn't type.
 */
export const HOSTNAME_ERROR_CODES = {
  INVALID_TARGET: "hostname_invalid",
  UNSUPPORTED_SCHEME: "hostname_scheme_not_allowed",
  EMBEDDED_CREDENTIALS: "hostname_credentials_not_allowed",
  PRIVATE_NETWORK_BLOCKED: "hostname_private_network",
  IP_ADDRESS_NOT_ALLOWED: "hostname_ip_address_not_allowed",
  PORT_NOT_ALLOWED: "hostname_port_not_allowed",
  PATH_NOT_ALLOWED: "hostname_path_not_allowed",
} as const satisfies Record<VerificationTargetFailure, string>;

/**
 * What a client is sent about a deployment. Built field by field from a
 * validated row, so a column added to the table is never passed through by
 * accident.
 *
 * - `hostname` is the stored, ASCII form. `unicodeHostname` is the same
 *   name for reading (`xn--bcher-kva.de` is `bücher.de`). A screen shows
 *   the ASCII form beside it whenever the two differ, so a lookalike
 *   (`аpple.com` with a Cyrillic "а") can't pass as another name (PR #26
 *   review, note 3; owner, 2026-09-22).
 * - `aiSystemStatus` is the system's status, read in the same query. A
 *   deployment of an archived system is never verified, whatever its own
 *   status (PR #25 review, finding 2; owner, 2026-09-22).
 */
export type SerializedDeployment = Readonly<{
  id: string;
  aiSystemId: string;
  aiSystemStatus: DeploymentStatus;
  hostname: string;
  unicodeHostname: string;
  status: DeploymentStatus;
  createdAt: string;
  updatedAt: string;
}>;
