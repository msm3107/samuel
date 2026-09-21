import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { AuthorizationError, MembershipLookupError } from "@/lib/auth/errors";
import {
  assertOrganizationRole,
  minimumRoleFor,
  ORGANIZATION_ROLES,
  roleSatisfies,
  type OrganizationPermission,
  type OrganizationRole,
} from "@/lib/auth/organization-roles";
import { requireSession } from "@/lib/auth/require-session";
import { createResolvingSessionClient } from "@/lib/database/session-client";
import { logger } from "@/lib/logging/logger";

declare const organizationAccessBrand: unique symbol;

/**
 * Proof that the signed-in user holds `role` in `organizationId`. Branded, so
 * the only way to get one without a cast is from the functions in this file.
 * Code that records or acts on someone's behalf, such as the audit recorder,
 * takes this rather than a user ID it would have to trust (TASK-006 review).
 */
export type OrganizationAccess = Readonly<{
  userId: string;
  organizationId: string;
  role: OrganizationRole;
  readonly [organizationAccessBrand]: true;
}>;

export type MemberManagementAccess = OrganizationAccess &
  Readonly<{ target: Readonly<{ userId: string; role: OrganizationRole }> }>;

type DenialReason =
  | "invalid_organization_id"
  | "not_a_member"
  | "insufficient_role"
  | "invalid_target_user_id"
  | "target_not_a_member"
  | "target_is_owner"
  | "assigns_owner";

const idSchema = z.uuid();
const membershipRowSchema = z.object({ role: z.enum(ORGANIZATION_ROLES) });

/**
 * The one answer to "may the signed-in user act at `minimumRole` in this
 * organization". Throws `AuthorizationError` rather than returning a boolean,
 * so a caller cannot forget to check.
 *
 * The organization ID comes from the route, so it is untrusted: it only names
 * what is being asked about. The user comes from `requireSession()`, and the
 * role from the database, read afresh on every call. Nothing about who the
 * user is or what they may do is accepted from the caller.
 *
 * Every refusal is the same error, so it cannot be used to probe which
 * organizations exist.
 */
export async function requireOrganizationRole({
  organizationId,
  minimumRole,
}: {
  organizationId: string;
  minimumRole: OrganizationRole;
}): Promise<OrganizationAccess> {
  // Before anything else: a caller's bug must never cost a query or be
  // decided by one.
  assertOrganizationRole(minimumRole);
  const { userId } = await requireSession();
  const parsedOrganizationId = idSchema.safeParse(organizationId);
  if (!parsedOrganizationId.success) {
    deny("invalid_organization_id", { userId });
  }

  const supabase = await membershipReader();
  const access = {
    userId,
    organizationId: parsedOrganizationId.data,
  };
  const role = await readRole(supabase, access.organizationId, userId);

  if (role === null) {
    deny("not_a_member", access);
  }
  if (!roleSatisfies(role, minimumRole)) {
    deny("insufficient_role", { ...access, role, minimumRole });
  }

  // The one place an OrganizationAccess is made.
  return Object.freeze({ ...access, role }) as OrganizationAccess;
}

/**
 * `requireOrganizationRole` at the minimum role the permission table sets.
 * Async so that an unknown permission, like every other failure, arrives as
 * a rejection rather than a synchronous throw.
 */
export async function requireOrganizationPermission({
  organizationId,
  permission,
}: {
  organizationId: string;
  permission: OrganizationPermission;
}): Promise<OrganizationAccess> {
  return requireOrganizationRole({
    organizationId,
    minimumRole: minimumRoleFor(permission),
  });
}

/**
 * For changing or removing another member. Admins manage members except
 * owners (README §10): an admin may not act on an owner, and only an owner may
 * make someone an owner, which is an ownership transfer.
 *
 * The target's role is read from the database, never taken from the caller.
 * A target who is not a member is refused like everything else.
 */
export async function requireMemberManagement({
  organizationId,
  targetUserId,
  assignsRole,
}: {
  organizationId: string;
  targetUserId: string;
  /** The role the change gives the target, if it gives one. */
  assignsRole?: OrganizationRole;
}): Promise<MemberManagementAccess> {
  if (assignsRole !== undefined) {
    assertOrganizationRole(assignsRole);
  }
  const actor = await requireOrganizationPermission({
    organizationId,
    permission: "members.manage",
  });
  const parsedTargetUserId = idSchema.safeParse(targetUserId);
  if (!parsedTargetUserId.success) {
    deny("invalid_target_user_id", actor);
  }

  const supabase = await membershipReader();
  const targetRole = await readRole(
    supabase,
    actor.organizationId,
    parsedTargetUserId.data,
  );

  if (targetRole === null) {
    deny("target_not_a_member", actor);
  }
  const isOwner = roleSatisfies(
    actor.role,
    minimumRoleFor("ownership.transfer"),
  );
  if (targetRole === "owner" && !isOwner) {
    deny("target_is_owner", actor);
  }
  if (assignsRole === "owner" && !isOwner) {
    deny("assigns_owner", actor);
  }

  return Object.freeze({
    ...actor,
    target: Object.freeze({
      userId: parsedTargetUserId.data,
      role: targetRole,
    }),
  });
}

/**
 * The signed-in user's own client, so row-level security applies to the read:
 * a user sees their own membership, and owners and admins see their team's.
 * Memberships of a deleted organization are hidden by the same policies.
 *
 * The resolving client, whose held cookie removals are never applied: reading
 * a membership must not be able to sign anyone out. `requireSession()` has
 * already settled whether the session is good.
 */
async function membershipReader(): Promise<SupabaseClient> {
  const { supabase } = await createResolvingSessionClient();
  return supabase;
}

async function readRole(
  supabase: SupabaseClient,
  organizationId: string,
  userId: string,
): Promise<OrganizationRole | null> {
  const { data, error } = await supabase
    .from("memberships")
    .select("role")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .maybeSingle();

  if (error) {
    throw new MembershipLookupError({ cause: error });
  }
  if (data === null) {
    return null;
  }

  // Database response: validated rather than trusted to be well-formed.
  const row = membershipRowSchema.safeParse(data);
  if (!row.success) {
    throw new MembershipLookupError({ cause: row.error });
  }
  return row.data.role;
}

/**
 * Logs why, then throws the one error every refusal shares. The reason stays
 * in private telemetry. Raw input that failed validation is never logged.
 */
function deny(
  reason: DenialReason,
  context: Readonly<{
    userId: string;
    organizationId?: string;
    role?: OrganizationRole;
    minimumRole?: OrganizationRole;
  }>,
): never {
  logger.info({ event: "organization_access_denied", reason, ...context });
  throw new AuthorizationError();
}
