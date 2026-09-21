import type { OrganizationAccess } from "@/lib/auth/require-organization-role";

/**
 * Test-only: an `OrganizationAccess` for code that takes one, without running
 * `requireOrganizationRole()`. The type is branded so application code cannot
 * build one by hand; this cast is the deliberate exception, kept in one place
 * and out of application code.
 */
export function testOrganizationAccess(
  access: Pick<OrganizationAccess, "userId" | "organizationId" | "role">,
): OrganizationAccess {
  return Object.freeze({ ...access }) as OrganizationAccess;
}
