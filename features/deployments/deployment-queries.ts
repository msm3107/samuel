import "server-only";

import { domainToUnicode } from "node:url";

import { z } from "zod";

import { AuthorizationError } from "@/lib/auth/errors";
import {
  minimumRoleFor,
  roleSatisfies,
  type OrganizationPermission,
} from "@/lib/auth/organization-roles";
import type { OrganizationAccess } from "@/lib/auth/require-organization-role";
import { createResolvingSessionClient } from "@/lib/database/session-client";
import { PUBLIC_DEPLOYMENT_ID_PATTERN } from "@/lib/security/public-id";

import {
  DEPLOYMENT_STATUSES,
  type DeploymentListFilter,
  type SerializedDeployment,
  type UpdateDeploymentInput,
} from "./deployment";

/**
 * Deployment reads and writes (TASK-013). Every function takes the proof
 * that the signed-in user holds a role in one organization, and every query
 * filters by that organization; row-level security enforces the same
 * boundary underneath (TASK-011).
 *
 * The hostname arrives already checked and normalized by
 * `validateVerificationTarget` (TASK-012). Audit events are written by the
 * database's triggers, in the same transaction as each change.
 */

/** Past this, a list is cut short and says so, as for AI systems. */
export const DEPLOYMENT_LIST_LIMIT = 200;

export type DeploymentList = Readonly<{
  deployments: SerializedDeployment[];
  truncated: boolean;
}>;

type Done = { status: "ok"; deployment: SerializedDeployment };
/** The system already has an active deployment at this hostname. */
type Exists = { status: "exists" };
/** The AI system is archived: nothing is registered or restored under it. */
type SystemArchived = { status: "ai_system_archived" };
/** No such AI system in this organization, including another's. */
type SystemNotFound = { status: "ai_system_not_found" };
/** No such deployment in this organization, including another's. */
type NotFound = { status: "not_found" };

export type CreateDeploymentResult =
  Done | Exists | SystemArchived | SystemNotFound;
export type UpdateDeploymentResult = Done | Exists | SystemArchived | NotFound;

/** The database refused in a way no validated request should cause. */
export class DeploymentQueryError extends Error {
  override readonly name = "DeploymentQueryError";

  constructor(
    readonly databaseCode: string | undefined,
    options?: ErrorOptions,
  ) {
    super("Deployments could not be read or written", options);
  }
}

/**
 * The columns every query selects: exactly what the serializer reads. The
 * AI system's status comes through the composite foreign key, so it is the
 * deployment's own system, under the same row-level security.
 */
const DEPLOYMENT_COLUMNS =
  "id, public_id, ai_system_id, hostname, status, created_at, updated_at, ai_system:ai_systems!deployments_ai_system_fkey(status)";

/** Timestamps are kept as the database printed them, as for AI systems. */
const timestamp = z.iso.datetime({ offset: true });

const deploymentRowSchema = z.object({
  id: z.uuid(),
  public_id: z.string().regex(PUBLIC_DEPLOYMENT_ID_PATTERN),
  ai_system_id: z.uuid(),
  hostname: z.string(),
  status: z.enum(DEPLOYMENT_STATUSES),
  created_at: timestamp,
  updated_at: timestamp,
  ai_system: z.object({ status: z.enum(DEPLOYMENT_STATUSES) }),
});

export function serializeDeployment(row: unknown): SerializedDeployment {
  const parsed = deploymentRowSchema.parse(row);
  return Object.freeze({
    id: parsed.id,
    publicId: parsed.public_id,
    aiSystemId: parsed.ai_system_id,
    aiSystemStatus: parsed.ai_system.status,
    hostname: parsed.hostname,
    // Empty only for a name IDNA can't decode, which the database's CHECK
    // and TASK-012 never store; the ASCII form is then the honest answer.
    unicodeHostname: domainToUnicode(parsed.hostname) || parsed.hostname,
    status: parsed.status,
    createdAt: parsed.created_at,
    updatedAt: parsed.updated_at,
  });
}

export async function listDeployments(
  access: OrganizationAccess,
  filter: DeploymentListFilter,
  aiSystemId: string | null,
): Promise<DeploymentList> {
  assertAccessAllows(access, "organization.read");
  const { supabase } = await createResolvingSessionClient();
  let query = supabase
    .from("deployments")
    .select(DEPLOYMENT_COLUMNS)
    .eq("organization_id", access.organizationId);
  if (filter !== "all") {
    query = query.eq("status", filter);
  }
  if (aiSystemId !== null) {
    query = query.eq("ai_system_id", aiSystemId);
  }
  // One more than the limit, to know whether there were more.
  const { data, error } = await query
    .order("hostname")
    .order("id")
    .limit(DEPLOYMENT_LIST_LIMIT + 1);
  if (error) {
    throw new DeploymentQueryError(error.code, { cause: error });
  }
  return {
    deployments: data.slice(0, DEPLOYMENT_LIST_LIMIT).map(serializeDeployment),
    truncated: data.length > DEPLOYMENT_LIST_LIMIT,
  };
}

export async function readDeployment(
  access: OrganizationAccess,
  deploymentId: string,
): Promise<SerializedDeployment | null> {
  assertAccessAllows(access, "organization.read");
  const { supabase } = await createResolvingSessionClient();
  const { data, error } = await supabase
    .from("deployments")
    .select(DEPLOYMENT_COLUMNS)
    .eq("organization_id", access.organizationId)
    .eq("id", deploymentId)
    .maybeSingle();
  if (error) {
    throw new DeploymentQueryError(error.code, { cause: error });
  }
  return data === null ? null : serializeDeployment(data);
}

/**
 * Registers a deployment. `hostname` must be `validateVerificationTarget`'s
 * output; the route passes nothing else.
 */
export async function createDeployment(
  access: OrganizationAccess,
  input: { aiSystemId: string; hostname: string },
): Promise<CreateDeploymentResult> {
  assertAccessAllows(access, "deployments.manage");
  const { supabase } = await createResolvingSessionClient();
  const { data, error } = await supabase
    .from("deployments")
    .insert({
      organization_id: access.organizationId,
      ai_system_id: input.aiSystemId,
      hostname: input.hostname,
    })
    .select(DEPLOYMENT_COLUMNS)
    .single();
  if (error) {
    // The composite foreign key: no such system in this organization.
    // Another organization's system fails the same way, so this reveals
    // nothing about it.
    if (error.code === "23503") {
      return { status: "ai_system_not_found" };
    }
    return refusal(error);
  }
  return { status: "ok", deployment: serializeDeployment(data) };
}

/** Archives or restores a deployment. */
export async function updateDeployment(
  access: OrganizationAccess,
  deploymentId: string,
  change: UpdateDeploymentInput,
): Promise<UpdateDeploymentResult> {
  assertAccessAllows(access, "deployments.manage");
  const { supabase } = await createResolvingSessionClient();
  const { data, error } = await supabase
    .from("deployments")
    .update({ status: change.status })
    .eq("organization_id", access.organizationId)
    .eq("id", deploymentId)
    .select(DEPLOYMENT_COLUMNS)
    .maybeSingle();
  if (error) {
    return refusal(error);
  }
  if (data === null) {
    return { status: "not_found" };
  }
  return { status: "ok", deployment: serializeDeployment(data) };
}

/**
 * The hint TASK-011's archived-system trigger carries (TASK-014 migration;
 * PR #27 review, note 2), so a reworded message can't change the answer.
 */
const SYSTEM_ARCHIVED_HINT = "ai_system_archived";

/**
 * The refusals a valid request can meet:
 *
 * - another active deployment of the system at this hostname (`23505`, on
 *   create or restore);
 * - an archived AI system (TASK-011's trigger: `23514` with its fixed
 *   hint, on create or restore). Any other `23514` is the hostname CHECK,
 *   which TASK-012's output always passes, so it is a fault;
 * - a role lowered or removed between the check and the insert (`42501`
 *   from RLS). On an update the same race hides the row instead, and the
 *   caller gets `not_found`, as for AI systems.
 */
function refusal(error: {
  code?: string;
  hint?: string | null;
}): Exists | SystemArchived {
  if (error.code === "23505") {
    return { status: "exists" };
  }
  if (error.code === "23514" && error.hint === SYSTEM_ARCHIVED_HINT) {
    return { status: "ai_system_archived" };
  }
  if (error.code === "42501") {
    throw new AuthorizationError();
  }
  throw new DeploymentQueryError(error.code, { cause: error });
}

/**
 * A proof of access for a lower role must not be reused for a write, as in
 * ai-system-queries.ts.
 */
function assertAccessAllows(
  access: OrganizationAccess,
  permission: OrganizationPermission,
): void {
  if (!roleSatisfies(access.role, minimumRoleFor(permission))) {
    throw new AuthorizationError();
  }
}
