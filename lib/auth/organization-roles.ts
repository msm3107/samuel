/**
 * Organization roles, least privileged first. The order is the hierarchy
 * (README §10): each role can do everything the roles before it can. It is
 * defined here once, as data, and compared only in `roleSatisfies`.
 */
export const ORGANIZATION_ROLES = [
  "viewer",
  "member",
  "admin",
  "owner",
] as const;

export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

/**
 * Whether `role` is `minimumRole` or ranks above it.
 *
 * Throws on a name that is not a role. Types rule that out, but a cast or a
 * value from configuration can slip one past them, and a missing role ranks
 * at -1: below every real role, so a misspelt minimum would admit everyone.
 * An unknown name is a bug, so it fails loudly rather than as a quiet refusal.
 */
export function roleSatisfies(
  role: OrganizationRole,
  minimumRole: OrganizationRole,
): boolean {
  return rankOf(role) >= rankOf(minimumRole);
}

/** Throws unless `value` is one of `ORGANIZATION_ROLES`, exactly. */
export function assertOrganizationRole(
  value: unknown,
): asserts value is OrganizationRole {
  if (!(ORGANIZATION_ROLES as readonly unknown[]).includes(value)) {
    throw new UnknownRoleError(value);
  }
}

function rankOf(role: OrganizationRole): number {
  assertOrganizationRole(role);
  return ORGANIZATION_ROLES.indexOf(role);
}

/**
 * What each role may do, as the least role that may do it (README §10).
 * Features name the permission rather than a role, so a change to who may do
 * something is a change to this table and nowhere else.
 *
 * Managing members also has a rule no single minimum can express: an admin
 * may not act on an owner or make anyone an owner. `requireMemberManagement`
 * enforces that part.
 */
export const ORGANIZATION_PERMISSIONS = {
  "organization.read": "viewer",
  // Renaming, and seeing the whole team: the database allows both to owners
  // and admins (organizations_update_owner_or_admin,
  // memberships_select_own_or_manager).
  "organization.update": "admin",
  "members.read": "admin",
  "systems.manage": "member",
  "deployments.manage": "member",
  "disclosures.manage": "member",
  "reports.generate": "member",
  "members.manage": "admin",
  "billing.manage": "owner",
  "ownership.transfer": "owner",
} as const satisfies Record<string, OrganizationRole>;

export type OrganizationPermission = keyof typeof ORGANIZATION_PERMISSIONS;

/**
 * The minimum role for `permission`. Throws on a name the table does not own:
 * `Object.hasOwn` rather than a plain lookup, so an inherited name such as
 * "constructor" is not mistaken for a permission.
 */
export function minimumRoleFor(
  permission: OrganizationPermission,
): OrganizationRole {
  if (!Object.hasOwn(ORGANIZATION_PERMISSIONS, permission)) {
    throw new UnknownPermissionError(permission);
  }
  return ORGANIZATION_PERMISSIONS[permission];
}

/**
 * A role or permission name the code does not define: a programming error,
 * never a user's doing. Not an `AuthorizationError`, so it surfaces as a
 * server error with a reference code instead of passing for an ordinary
 * refusal. The name is not echoed, in case it came from input.
 */
export class UnknownRoleError extends Error {
  override readonly name = "UnknownRoleError";

  constructor(value: unknown) {
    super(`Not an organization role (${typeof value})`);
  }
}

export class UnknownPermissionError extends Error {
  override readonly name = "UnknownPermissionError";

  constructor(value: unknown) {
    super(`Not an organization permission (${typeof value})`);
  }
}
