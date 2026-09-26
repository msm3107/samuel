import { SYSTEM_STATUSES } from "@/features/ai-systems/ai-system";
import type { CurrentDisclosureState } from "@/features/disclosures/disclosure";

import type { DeploymentStatus } from "./deployment";

/**
 * Whether an installed tag would render anything today (TASK-021).
 *
 * The public endpoint cannot say. `public.public_disclosure` answers
 * identically for every reason there is nothing to show, deliberately, so
 * that it is no oracle for which deployments exist (TASK-019). The widget
 * is silent for the same reason. The dashboard is therefore the only place
 * that can tell the person who is entitled to know which of those reasons
 * applies to their own deployment.
 *
 * This mirrors the conditions in that function, in the order it applies
 * them. One condition it has is missing on purpose: `o.deleted_at is null`
 * is unreachable here, because nobody reads a closed organization's
 * dashboard — access is refused before this page renders. If that SQL ever
 * grows a condition, this is the one other place that has to learn it.
 */

export type InstallReadiness =
  /** Every condition holds: this version is what visitors see. */
  | { readonly state: "live"; readonly version: number }
  /** The deployment is archived; its public ID resolves to nothing. */
  | { readonly state: "deployment_archived" }
  /** Its AI system is archived, so nothing under it resolves. */
  | { readonly state: "system_archived" }
  /** The AI system has never published a version. */
  | { readonly state: "never_published" }
  /** A current version exists and is turned off. */
  | { readonly state: "disabled"; readonly version: number };

export type InstallReadinessState = InstallReadiness["state"];

export function installReadiness(input: {
  deploymentStatus: DeploymentStatus;
  aiSystemStatus: (typeof SYSTEM_STATUSES)[number];
  current: CurrentDisclosureState;
}): InstallReadiness {
  // The deployment first, so a deployment archived under an archived
  // system reports the thing this page is about.
  if (input.deploymentStatus === "archived") {
    return { state: "deployment_archived" };
  }
  if (input.aiSystemStatus === "archived") {
    return { state: "system_archived" };
  }
  if (input.current === null) {
    return { state: "never_published" };
  }
  // `enabled` is required of the current version: a notice turned off is
  // turned off, never replaced by an older one that was on.
  return input.current.enabled
    ? { state: "live", version: input.current.version }
    : { state: "disabled", version: input.current.version };
}
