import type { HostnameErrorCode } from "@/features/deployments/deployment-fields";
import type { InstallReadinessState } from "@/features/deployments/install-readiness";

/**
 * What the deployment forms can report (TASK-015), each with fixed text. An
 * action returns only a code; the page shows the text from these tables, so
 * nothing the server or a forged request chooses is put on the page as a
 * message.
 */

export function deploymentPath(
  organizationId: string,
  deploymentId: string,
): string {
  return `/dashboard/${organizationId}/deployments/${deploymentId}`;
}

/** Why TASK-012 refused a hostname, and what to type instead. */
export const HOSTNAME_MESSAGES = {
  hostname_invalid:
    "Enter a hostname such as www.example.com, or a site address such as https://www.example.com/, without spaces or invisible characters.",
  hostname_scheme_not_allowed:
    "Only http:// and https:// addresses can be registered.",
  hostname_credentials_not_allowed:
    "Remove the user name and password from the address.",
  hostname_private_network:
    "This name or address is for local, private or reserved use, so it can't be checked from the internet. Enter the public hostname your visitors use.",
  hostname_ip_address_not_allowed:
    "Enter the site's hostname, not an IP address.",
  hostname_port_not_allowed:
    "Remove the port. Only sites on the standard ports (80 for http, 443 for https) can be checked.",
  hostname_path_not_allowed:
    "Enter the site's address without a page, query or fragment: https://www.example.com/, not https://www.example.com/contact.",
} as const satisfies Record<HostnameErrorCode, string>;

export const DEPLOYMENT_FORM_MESSAGES = {
  ...HOSTNAME_MESSAGES,
  exists: "This AI system already has an active deployment at this hostname.",
  ai_system_archived:
    "This AI system is archived, so nothing can be registered under it. Restore the system first.",
  ai_system_not_found: "This AI system is no longer in this organization.",
  not_permitted:
    "You no longer have permission to change this organization's deployments.",
} as const;

export type DeploymentFormResult = keyof typeof DEPLOYMENT_FORM_MESSAGES;

/**
 * What the registration action returns after a refusal; a registration that
 * succeeds opens the new deployment instead. `value` is the hostname as
 * typed, for the input.
 */
export type DeploymentFormState = Readonly<{
  result: DeploymentFormResult;
  value: string;
}> | null;

export const DEPLOYMENT_STATUS_MESSAGES = {
  archived:
    "Archived. Its public ID no longer works; restoring it brings the same ID back.",
  restored: "Restored. It is active again, with the same public ID.",
  exists:
    "It can't be restored while this AI system has another active deployment at this hostname.",
  ai_system_archived:
    "It can't be restored while its AI system is archived. Restore the system first.",
  not_permitted:
    "You no longer have permission to change this organization's deployments.",
  not_found: "This deployment is no longer in this organization.",
  invalid: "That change isn't possible.",
} as const;

export type DeploymentStatusResult = keyof typeof DEPLOYMENT_STATUS_MESSAGES;

export type DeploymentStatusState = Readonly<{
  result: DeploymentStatusResult;
}> | null;

/** Whether a status result is a refusal, to mark it as a problem in words. */
export function isStatusProblem(result: DeploymentStatusResult): boolean {
  return result !== "archived" && result !== "restored";
}

/**
 * What the installation section says about whether an installed tag would
 * render anything (TASK-021). The public endpoint answers the same way for
 * every one of these, on purpose; this screen is where they are told apart,
 * for the person entitled to know.
 */
export const INSTALL_READINESS_MESSAGES = {
  live: "This tag is showing the current notice to visitors.",
  deployment_archived:
    "This deployment is archived, so the tag renders nothing. Restore it to start showing the notice again.",
  system_archived:
    "Its AI system is archived, so the tag renders nothing until the system is restored.",
  never_published:
    "No notice has been published for this AI system yet, so the tag renders nothing. Install it now if you like: it starts showing the notice the moment one is published.",
  disabled:
    "The current notice is turned off, so the tag renders nothing. Turn it on to start showing it again.",
} as const satisfies Record<InstallReadinessState, string>;

/** Whether the tag would render nothing today, to mark it as a caution. */
export function isNotShowing(state: InstallReadinessState): boolean {
  return state !== "live";
}
