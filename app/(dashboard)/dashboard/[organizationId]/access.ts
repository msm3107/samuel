import "server-only";

import { notFound } from "next/navigation";

import { AuthorizationError } from "@/lib/auth/errors";
import type { OrganizationPermission } from "@/lib/auth/organization-roles";
import {
  requireOrganizationPermission,
  type OrganizationAccess,
} from "@/lib/auth/require-organization-role";
import { requireDashboardSession } from "@/lib/auth/require-session";

/**
 * The organization a dashboard URL names, authorized (TASK-010). The ID in
 * the path only says what is being asked about; the user comes from the
 * session and the role from the database, as for the API routes.
 *
 * A refusal renders the not-found page, whatever its cause: not a member, a
 * role too low, a deleted organization, or an ID that is not one. Nothing on
 * the page tells them apart. A failed lookup is thrown, and renders as an
 * error with a reference, never as "not found".
 */
export async function organizationAccessOrNotFound(
  organizationId: string,
  permission: OrganizationPermission,
): Promise<OrganizationAccess> {
  await requireDashboardSession();
  try {
    return await requireOrganizationPermission({ organizationId, permission });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      notFound();
    }
    throw error;
  }
}

/**
 * The same check for a server action, which answers in its form rather than
 * with a page: `null` when the user may not do this here.
 */
export async function organizationAccessOrNull(
  organizationId: string,
  permission: OrganizationPermission,
): Promise<OrganizationAccess | null> {
  await requireDashboardSession();
  try {
    return await requireOrganizationPermission({ organizationId, permission });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return null;
    }
    throw error;
  }
}
