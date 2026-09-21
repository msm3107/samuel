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

/** Whether `role` is `minimumRole` or ranks above it. */
export function roleSatisfies(
  role: OrganizationRole,
  minimumRole: OrganizationRole,
): boolean {
  return (
    ORGANIZATION_ROLES.indexOf(role) >= ORGANIZATION_ROLES.indexOf(minimumRole)
  );
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
  "systems.manage": "member",
  "deployments.manage": "member",
  "disclosures.manage": "member",
  "reports.generate": "member",
  "members.manage": "admin",
  "billing.manage": "owner",
  "ownership.transfer": "owner",
} as const satisfies Record<string, OrganizationRole>;

export type OrganizationPermission = keyof typeof ORGANIZATION_PERMISSIONS;
