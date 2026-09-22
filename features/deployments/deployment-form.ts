import { validateVerificationTarget } from "@/lib/security/verification-target";

import { HOSTNAME_ERROR_CODES } from "./deployment";
import { HOSTNAME_FIELD, type HostnameErrorCode } from "./deployment-fields";

/**
 * The dashboard's deployment registration form (TASK-015): what it reads
 * from a submitted form. Server-only, through TASK-012's validator; the
 * field's name and the labels are in `deployment-fields.ts`, for client
 * components. The rules are TASK-012's validator and TASK-013's schemas;
 * this only turns the form into their input.
 */

/**
 * Twice the validator's input limit, so a value too long to register still
 * comes back as typed, but a forged megabyte does not come back at all. A
 * value cut here was already over the limit, so it is refused either way.
 */
const ECHO_LIMIT = 2048;

export type ParsedDeploymentForm =
  | { success: true; hostname: string; value: string }
  | { success: false; code: HostnameErrorCode; value: string };

/**
 * Reads the `hostname` field and nothing else: an organization, AI system,
 * status or public ID a forged request adds is never looked at.
 *
 * `hostname` is `validateVerificationTarget`'s output, the only form ever
 * stored (TASK-012). `value` is what was typed, to put back in the input; it
 * is only ever rendered as an input's value, which React escapes.
 */
export function parseDeploymentForm(formData: unknown): ParsedDeploymentForm {
  const submitted =
    formData instanceof FormData ? formData.get(HOSTNAME_FIELD) : null;
  const value =
    typeof submitted === "string" ? submitted.slice(0, ECHO_LIMIT) : "";
  const target = validateVerificationTarget(value);
  if (!target.ok) {
    return { success: false, code: HOSTNAME_ERROR_CODES[target.code], value };
  }
  return { success: true, hostname: target.hostname, value };
}
