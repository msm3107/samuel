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
  AI_SYSTEM_COLUMNS,
  serializeAiSystem,
  type AiSystemListFilter,
  type CreateAiSystemInput,
  type SerializedAiSystem,
  type UpdateAiSystemInput,
} from "./ai-system";

/**
 * AI system reads and writes (TASK-009). Every function takes the proof that
 * the signed-in user holds a role in one organization, and every query
 * filters by that organization: there is no lookup by system ID alone.
 * Row-level security enforces the same boundary again underneath.
 *
 * Audit events are written by the database's triggers (TASK-008), in the
 * same transaction as each change, so nothing here records them.
 */

/**
 * Past this, a list is cut short, and says so: `truncated` is true (PR #23
 * review, finding 1). No organization is near it yet; paging comes when one
 * is.
 */
export const AI_SYSTEM_LIST_LIMIT = 200;

export type AiSystemList = Readonly<{
  aiSystems: SerializedAiSystem[];
  truncated: boolean;
}>;

type Created = { status: "ok"; aiSystem: SerializedAiSystem };
/** Another active system in this organization has the name. */
type NameTaken = { status: "name_taken" };
/** No such system in this organization, including another's system. */
type NotFound = { status: "not_found" };

export type CreateAiSystemResult = Created | NameTaken;
export type UpdateAiSystemResult = Created | NameTaken | NotFound;

/** The database refused in a way no validated request should cause. */
export class AiSystemQueryError extends Error {
  override readonly name = "AiSystemQueryError";

  constructor(
    readonly databaseCode: string | undefined,
    options?: ErrorOptions,
  ) {
    super("AI systems could not be read or written", options);
  }
}

type DatabaseError = { code?: string } | null;

export async function listAiSystems(
  access: OrganizationAccess,
  filter: AiSystemListFilter,
): Promise<AiSystemList> {
  assertAccessAllows(access, "organization.read");
  const { supabase } = await createResolvingSessionClient();
  let query = supabase
    .from("ai_systems")
    .select(AI_SYSTEM_COLUMNS)
    .eq("organization_id", access.organizationId);
  if (filter !== "all") {
    query = query.eq("status", filter);
  }
  // One more than the limit, to know whether there were more.
  const { data, error } = await query
    .order("name")
    .order("id")
    .limit(AI_SYSTEM_LIST_LIMIT + 1);
  if (error) {
    throw new AiSystemQueryError(error.code, { cause: error });
  }
  return {
    aiSystems: data.slice(0, AI_SYSTEM_LIST_LIMIT).map(serializeAiSystem),
    truncated: data.length > AI_SYSTEM_LIST_LIMIT,
  };
}

export async function readAiSystem(
  access: OrganizationAccess,
  systemId: string,
): Promise<SerializedAiSystem | null> {
  assertAccessAllows(access, "organization.read");
  const { supabase } = await createResolvingSessionClient();
  const { data, error } = await supabase
    .from("ai_systems")
    .select(AI_SYSTEM_COLUMNS)
    .eq("organization_id", access.organizationId)
    .eq("id", systemId)
    .maybeSingle();
  if (error) {
    throw new AiSystemQueryError(error.code, { cause: error });
  }
  return data === null ? null : serializeAiSystem(data);
}

export async function createAiSystem(
  access: OrganizationAccess,
  input: CreateAiSystemInput,
): Promise<CreateAiSystemResult> {
  assertAccessAllows(access, "systems.manage");
  const { supabase } = await createResolvingSessionClient();
  const { data, error } = await supabase
    .from("ai_systems")
    .insert({
      organization_id: access.organizationId,
      name: input.name,
      system_type: input.systemType,
      description: input.description ?? null,
      provider: input.provider ?? null,
    })
    .select(AI_SYSTEM_COLUMNS)
    .single();
  if (error) {
    return refusal(error);
  }
  return { status: "ok", aiSystem: serializeAiSystem(data) };
}

export async function updateAiSystem(
  access: OrganizationAccess,
  systemId: string,
  change: UpdateAiSystemInput,
): Promise<UpdateAiSystemResult> {
  assertAccessAllows(access, "systems.manage");
  const { supabase } = await createResolvingSessionClient();
  const { data, error } = await supabase
    .from("ai_systems")
    .update(toColumns(change))
    .eq("organization_id", access.organizationId)
    .eq("id", systemId)
    .select(AI_SYSTEM_COLUMNS)
    .maybeSingle();
  if (error) {
    return refusal(error);
  }
  return data === null
    ? { status: "not_found" }
    : { status: "ok", aiSystem: serializeAiSystem(data) };
}

/** Only the fields the change names, so an omitted field is left alone. */
function toColumns(change: UpdateAiSystemInput): Record<string, unknown> {
  const columns: Record<string, unknown> = {};
  if (change.name !== undefined) {
    columns.name = change.name;
  }
  if (change.systemType !== undefined) {
    columns.system_type = change.systemType;
  }
  if (change.description !== undefined) {
    columns.description = change.description;
  }
  if (change.provider !== undefined) {
    columns.provider = change.provider;
  }
  if (change.status !== undefined) {
    columns.status = change.status;
  }
  return columns;
}

/**
 * The refusals a valid request can meet: a name another active system has
 * (`23505`, on create, rename or un-archive), and, on create only, a role
 * lowered or removed between the check and the insert (`42501` from RLS).
 * On an update the same race raises nothing: RLS hides the row, so the
 * caller gets `not_found` (404) rather than 403. It is refused either way
 * and leaks nothing (PR #23 review, finding 3). Anything else is a fault,
 * not the caller's.
 */
function refusal(error: NonNullable<DatabaseError>): NameTaken {
  if (error.code === "23505") {
    return { status: "name_taken" };
  }
  if (error.code === "42501") {
    throw new AuthorizationError();
  }
  throw new AiSystemQueryError(error.code, { cause: error });
}

/**
 * A proof of access for a lower role must not be reused for a write, as in
 * organization-queries.ts.
 */
function assertAccessAllows(
  access: OrganizationAccess,
  permission: OrganizationPermission,
): void {
  if (!roleSatisfies(access.role, minimumRoleFor(permission))) {
    throw new AuthorizationError();
  }
}
