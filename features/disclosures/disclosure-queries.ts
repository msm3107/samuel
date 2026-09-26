import "server-only";

import { z } from "zod";

import { SYSTEM_STATUSES } from "@/features/ai-systems/ai-system";
import { AuthorizationError } from "@/lib/auth/errors";
import {
  minimumRoleFor,
  roleSatisfies,
  type OrganizationPermission,
} from "@/lib/auth/organization-roles";
import type { OrganizationAccess } from "@/lib/auth/require-organization-role";
import { createResolvingSessionClient } from "@/lib/database/session-client";

import type {
  CurrentDisclosureState,
  PublishDisclosureInput,
  SerializedDisclosure,
} from "./disclosure";
import { DISCLOSURE_LANGUAGES } from "./languages";

/**
 * Disclosure reads and publishes (TASK-017). Every function takes the proof
 * that the signed-in user holds a role in one organization, and every query
 * filters by that organization; row-level security enforces the same
 * boundary underneath (TASK-016).
 *
 * Versions are numbered, stamped and audited by the database, in the same
 * transaction as each publish.
 */

/** Past this, a history is cut short and says so, as for AI systems. */
export const DISCLOSURE_LIST_LIMIT = 200;

export type DisclosureHistory = Readonly<{
  aiSystemStatus: (typeof SYSTEM_STATUSES)[number];
  /** Newest first: the first is the current version, unless `before`. */
  disclosures: SerializedDisclosure[];
  /** More versions remain below the last one returned. */
  truncated: boolean;
}>;

/**
 * Which page of the history to read (TASK-018a). `before` is exclusive, so
 * a caller passes the last version it was given and the next page starts
 * one below it, with nothing repeated and nothing skipped. The caller
 * builds its own next cursor from the last row, so nothing is returned
 * that the rows do not already say.
 */
export type DisclosureHistoryPage = Readonly<{
  before?: number | undefined;
}>;

type Published = { status: "ok"; disclosure: SerializedDisclosure };
/** A newer version exists than the one the publish was based on. */
type Changed = { status: "disclosure_changed" };
/** The same message, language and on or off as the current version. */
type Unchanged = { status: "disclosure_unchanged" };
/** The AI system is archived: nothing is published under it. */
type SystemArchived = { status: "ai_system_archived" };
/** No such AI system in this organization, including another's. */
type SystemNotFound = { status: "ai_system_not_found" };

export type PublishDisclosureResult =
  Published | Changed | Unchanged | SystemArchived | SystemNotFound;

/** The database refused in a way no validated request should cause. */
export class DisclosureQueryError extends Error {
  override readonly name = "DisclosureQueryError";

  constructor(
    readonly databaseCode: string | undefined,
    options?: ErrorOptions,
  ) {
    super("Disclosures could not be read or published", options);
  }
}

/** The columns every query selects: exactly what the serializer reads. */
const DISCLOSURE_COLUMNS =
  "id, version, message, language, enabled, created_at, created_by";

/** Timestamps are kept as the database printed them, as for AI systems. */
const timestamp = z.iso.datetime({ offset: true });

const disclosureRowSchema = z.object({
  id: z.uuid(),
  version: z.int().min(1),
  message: z.string(),
  language: z.enum(DISCLOSURE_LANGUAGES),
  enabled: z.boolean(),
  created_at: timestamp,
  created_by: z.uuid(),
});

export function serializeDisclosure(row: unknown): SerializedDisclosure {
  const parsed = disclosureRowSchema.parse(row);
  return Object.freeze({
    id: parsed.id,
    version: parsed.version,
    message: parsed.message,
    language: parsed.language,
    enabled: parsed.enabled,
    createdAt: parsed.created_at,
    createdBy: parsed.created_by,
  });
}

const historyRowSchema = z.object({
  status: z.enum(SYSTEM_STATUSES),
  disclosures: z.array(z.unknown()),
});

/**
 * One AI system's versions, newest first, or null if the organization has
 * no such system. One query: the system, with its versions through the
 * composite foreign key, so an unknown system and a system with no versions
 * are told apart without a second lookup.
 *
 * `page.before` reads an older page (TASK-018a): one more predicate on the
 * same query, over `(ai_system_id, version)`, which TASK-016 already made
 * unique. A version is never reused or changed, so a publish while someone
 * is paging cannot shift a page under them. The cursor names no
 * organization and no system; RLS refuses every row that is not the
 * caller's, cursor or no cursor.
 */
export async function listDisclosures(
  access: OrganizationAccess,
  aiSystemId: string,
  page: DisclosureHistoryPage = {},
): Promise<DisclosureHistory | null> {
  assertAccessAllows(access, "organization.read");
  const { supabase } = await createResolvingSessionClient();
  // One more than the limit, to know whether there were more.
  const query = supabase
    .from("ai_systems")
    .select(
      `status, disclosures!disclosures_ai_system_fkey(${DISCLOSURE_COLUMNS})`,
    )
    .eq("organization_id", access.organizationId)
    .eq("id", aiSystemId)
    .order("version", { referencedTable: "disclosures", ascending: false })
    .limit(DISCLOSURE_LIST_LIMIT + 1, { referencedTable: "disclosures" });
  // Filters the embedded versions, not the system: a system with no version
  // below the cursor is still found, with an empty page.
  const { data, error } = await (
    page.before === undefined
      ? query
      : query.lt("disclosures.version", page.before)
  ).maybeSingle();
  if (error) {
    throw new DisclosureQueryError(error.code, { cause: error });
  }
  if (data === null) {
    return null;
  }
  const parsed = historyRowSchema.parse(data);
  return {
    aiSystemStatus: parsed.status,
    disclosures: parsed.disclosures
      .slice(0, DISCLOSURE_LIST_LIMIT)
      .map(serializeDisclosure),
    truncated: parsed.disclosures.length > DISCLOSURE_LIST_LIMIT,
  };
}

/**
 * The newest version of one AI system's notice, or null if it has none
 * (TASK-021). Two columns of one row: the dashboard's installation section
 * asks whether an installed tag would render anything, which the public
 * endpoint deliberately cannot answer.
 *
 * Not `listDisclosures`: that reads up to 201 rows with their full
 * messages, which is a large read for a yes-or-no question on a screen that
 * shows no message. `enabled` is read from the current version alone, as
 * `public.public_disclosure` requires it — a notice turned off is turned
 * off, never replaced by an older one that was on.
 *
 * The same session client and the same row-level security as every other
 * read here: another organization's system returns null rather than a row.
 */
export async function readCurrentDisclosureState(
  access: OrganizationAccess,
  aiSystemId: string,
): Promise<CurrentDisclosureState> {
  assertAccessAllows(access, "organization.read");
  const { supabase } = await createResolvingSessionClient();
  const { data, error } = await supabase
    .from("disclosures")
    .select("version, enabled")
    .eq("organization_id", access.organizationId)
    .eq("ai_system_id", aiSystemId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    throw new DisclosureQueryError(error.code, { cause: error });
  }
  if (data === null) {
    return null;
  }
  const parsed = currentStateSchema.parse(data);
  return Object.freeze({ version: parsed.version, enabled: parsed.enabled });
}

const currentStateSchema = z.object({
  version: z.int().min(1),
  enabled: z.boolean(),
});

/**
 * Publishes a version through `public.publish_disclosure`, which refuses it
 * if the system's current version is no longer `expectedVersion`, under
 * the same lock as the insert (TASK-017 migration).
 */
export async function publishDisclosure(
  access: OrganizationAccess,
  aiSystemId: string,
  input: PublishDisclosureInput,
): Promise<PublishDisclosureResult> {
  assertAccessAllows(access, "disclosures.manage");
  const { supabase } = await createResolvingSessionClient();
  const { data, error } = await supabase.rpc("publish_disclosure", {
    p_organization_id: access.organizationId,
    p_ai_system_id: aiSystemId,
    p_message: input.message,
    p_language: input.language,
    p_enabled: input.enabled,
    p_expected_version: input.expectedVersion,
  });
  if (error) {
    return refusal(error);
  }
  return { status: "ok", disclosure: serializeDisclosure(data) };
}

/** The fixed hints the database's refusals carry (TASK-016, TASK-017). */
const HINTS = {
  changed: "disclosure_changed",
  unchanged: "disclosure_unchanged",
  systemArchived: "ai_system_archived",
} as const;

/**
 * The refusals a valid request can meet, matched by code and fixed hint,
 * never by message text:
 *
 * - `23503`: no such system in this organization. Another organization's
 *   system, or a soft-deleted organization's, fails the same way, whatever
 *   it has published, so this reveals nothing (TASK-016, decision 9).
 * - `PT409` with `disclosure_changed` or `disclosure_unchanged`.
 * - `23505`: the unique version key, which only a concurrent direct insert
 *   that skipped the stale check can reach. Another version won, so it is
 *   `disclosure_changed`.
 * - `23514` with `ai_system_archived`. Any other `23514` is the message or
 *   language CHECK, which a validated input always passes, so it is a
 *   fault.
 * - `42501`: a role lowered or removed between the check and the publish
 *   (RLS). The same code for another organization reaches `23503` first.
 */
function refusal(error: {
  code?: string;
  hint?: string | null;
}): Changed | Unchanged | SystemArchived | SystemNotFound {
  if (error.code === "23503") {
    return { status: "ai_system_not_found" };
  }
  if (error.code === "PT409" && error.hint === HINTS.changed) {
    return { status: "disclosure_changed" };
  }
  if (error.code === "PT409" && error.hint === HINTS.unchanged) {
    return { status: "disclosure_unchanged" };
  }
  if (error.code === "23505") {
    return { status: "disclosure_changed" };
  }
  if (error.code === "23514" && error.hint === HINTS.systemArchived) {
    return { status: "ai_system_archived" };
  }
  if (error.code === "42501") {
    throw new AuthorizationError();
  }
  throw new DisclosureQueryError(error.code, { cause: error });
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
