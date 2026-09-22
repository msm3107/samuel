/**
 * Public identifiers (TASK-014; README §11, §67): the database generates
 * them (`private.generate_public_id`), and this module recognizes them.
 * Phase 6's configuration endpoint checks an ID's shape here before any
 * lookup, so a malformed one costs no query.
 *
 * A public ID names what to render; it is never authorization.
 */

/**
 * `dep_` and 26 characters of lowercase base32 (a-z, 2-7): 130 random
 * bits. The same pattern as the `deployments_public_id_check` constraint;
 * a real-database test keeps the two in step.
 */
export const PUBLIC_DEPLOYMENT_ID_PATTERN = /^dep_[a-z2-7]{26}$/;

/**
 * Whether `value` has a public deployment ID's shape. Exact: no trimming
 * and no case folding, so each deployment has one spelling.
 */
export function isPublicDeploymentId(value: unknown): value is string {
  return typeof value === "string" && PUBLIC_DEPLOYMENT_ID_PATTERN.test(value);
}
