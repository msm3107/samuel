import type { DeploymentStatus, HOSTNAME_ERROR_CODES } from "./deployment";

/**
 * What the deployment screens' client components may import (TASK-015):
 * names and labels only. The form's parser is in `deployment-form.ts`,
 * apart from these, because it calls TASK-012's validator, which is
 * server-only.
 */

export const HOSTNAME_FIELD = "hostname";

/** The code for each reason TASK-012 refuses a hostname, as the API sends it. */
export type HostnameErrorCode =
  (typeof HOSTNAME_ERROR_CODES)[keyof typeof HOSTNAME_ERROR_CODES];

export const DEPLOYMENT_STATUS_LABELS = {
  active: "Active",
  archived: "Archived",
} as const satisfies Record<DeploymentStatus, string>;
