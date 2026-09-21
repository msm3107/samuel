import "server-only";

import { AuthorizationError } from "@/lib/auth/errors";
import {
  minimumRoleFor,
  roleSatisfies,
  type OrganizationPermission,
} from "@/lib/auth/organization-roles";
import type { OrganizationAccess } from "@/lib/auth/require-organization-role";
import { createResolvingSessionClient } from "@/lib/database/session-client";

import {
  ORGANIZATION_COLUMNS,
  serializeOrganization,
  type OrganizationName,
  type SerializedOrganization,
} from "./organization";

/** A query failed, so nothing was decided. Surfaces as a 500. */
export class OrganizationQueryError extends Error {
  override readonly name = "OrganizationQueryError";

  constructor(
    readonly databaseCode: string | undefined,
    options?: ErrorOptions,
  ) {
    super("Organizations could not be read", options);
  }
}

/**
 * The organizations the signed-in user belongs to, by name. Row-level
 * security decides which: the query names no user and no organization, so
 * it cannot be pointed at anyone else's. Deleted organizations are excluded
 * by the same policy.
 */
export async function listOrganizations(): Promise<SerializedOrganization[]> {
  const { supabase } = await createResolvingSessionClient();
  const { data, error } = await supabase
    .from("organizations")
    .select(ORGANIZATION_COLUMNS)
    .order("name")
    .order("id");
  if (error) {
    throw new OrganizationQueryError(error.code, { cause: error });
  }
  return data.map(serializeOrganization);
}

/**
 * The organization `access` was granted for. Takes the proof of access, not
 * an ID, so it cannot be called for an organization nobody checked.
 */
export async function readOrganization(
  access: OrganizationAccess,
): Promise<SerializedOrganization> {
  assertAccessAllows(access, "organization.read");
  const { supabase } = await createResolvingSessionClient();
  const { data, error } = await supabase
    .from("organizations")
    .select(ORGANIZATION_COLUMNS)
    .eq("id", access.organizationId)
    .maybeSingle();
  if (error) {
    throw new OrganizationQueryError(error.code, { cause: error });
  }
  // Deleted between the check and this read: the same answer as any other
  // organization the user cannot see.
  if (data === null) {
    throw new AuthorizationError();
  }
  return serializeOrganization(data);
}

/**
 * Renames the organization `access` was granted for. Owners and admins only,
 * which row-level security enforces again: only the `name` column is
 * granted, and the policy checks the role.
 */
export async function renameOrganization(
  access: OrganizationAccess,
  name: OrganizationName,
): Promise<SerializedOrganization> {
  assertAccessAllows(access, "organization.update");
  const { supabase } = await createResolvingSessionClient();
  const { data, error } = await supabase
    .from("organizations")
    .update({ name })
    .eq("id", access.organizationId)
    .select(ORGANIZATION_COLUMNS)
    .maybeSingle();
  if (error) {
    throw new OrganizationQueryError(error.code, { cause: error });
  }
  if (data === null) {
    throw new AuthorizationError();
  }
  return serializeOrganization(data);
}

/**
 * A proof of access for a lower role must not be reused for a higher-role
 * action: a route that checked `organization.read` and then renamed would be
 * refused here, before row-level security refuses it again.
 */
function assertAccessAllows(
  access: OrganizationAccess,
  permission: OrganizationPermission,
): void {
  if (!roleSatisfies(access.role, minimumRoleFor(permission))) {
    throw new AuthorizationError();
  }
}
