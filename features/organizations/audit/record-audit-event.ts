import "server-only";

import type { OrganizationAccess } from "@/lib/auth/require-organization-role";
import { createServiceRoleClient } from "@/lib/database/service-role-client";
import { logger } from "@/lib/logging/logger";

import { AUDIT_EVENTS, toAuditEventRow, type AuditEvent } from "./audit-events";

export type AuditRecordResult = { recorded: true } | { recorded: false };

/**
 * Records `event` as done by the user `access` names, in the organization
 * it names.
 *
 * Takes the result of `requireOrganizationRole()` rather than a user ID and
 * an organization ID, so the actor and the organization are the ones the
 * request was authorized for. Neither can come from the request itself.
 *
 * Writes with the service role. Users have no insert grant on
 * `audit_events`, because a user writing through the Data API could forge
 * history. The session client cannot serve this, so this is not a request
 * the service role takes over from it.
 *
 * Never throws. An audit write that fails must not undo or fail the action
 * it describes, which has already happened. It is logged at error level
 * instead, with the event type and organization, never the metadata. The
 * result says whether the event was recorded, for callers and tests that
 * care.
 */
export async function recordAuditEvent(
  access: OrganizationAccess,
  event: AuditEvent,
): Promise<AuditRecordResult> {
  try {
    const row = toAuditEventRow(
      { organizationId: access.organizationId, actorUserId: access.userId },
      event,
    );
    const { error } = await createServiceRoleClient()
      .from("audit_events")
      .insert(row);
    if (error) {
      throw error;
    }
    return { recorded: true };
  } catch (error) {
    logger.error(
      {
        event: "audit_event_not_recorded",
        // Only a known type is logged: whatever a cast put there is not.
        auditEventType:
          typeof event?.type === "string" &&
          Object.hasOwn(AUDIT_EVENTS, event.type)
            ? event.type
            : "unknown",
        organizationId: access.organizationId,
        errorName: error instanceof Error ? error.name : "unknown",
        errorCode: hasCode(error) ? error.code : undefined,
      },
      "An audit event could not be recorded",
    );
    return { recorded: false };
  }
}

function hasCode(error: unknown): error is { code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  );
}
