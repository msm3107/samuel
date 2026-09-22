import { z } from "zod";

import { ORGANIZATION_ROLES } from "@/lib/auth/organization-roles";

/**
 * Every audit event type, each with the entity it describes and the exact
 * metadata it may carry. Kept in step with the `audit_events_event_type_check`
 * constraint: a new type needs a migration and an entry here.
 *
 * Metadata schemas are strict and hold enums and numbers only, never free
 * text. That keeps out tokens, headers, payment data and personal
 * information by construction: there is no field one could land in. The
 * target of a member event is its membership ID (`entityId`), never the
 * member's user ID or email. The actor is the only person an audit row
 * names (TASK-006).
 */
const role = z.enum(ORGANIZATION_ROLES);

/** The plans Stripe will sell (Phase 10), plus "none" for no subscription. */
const plan = z.enum(["none", "founder", "agency", "agency_pro"]);

const noMetadata = z.strictObject({});

export const AUDIT_EVENTS = {
  "organization.created": { entityType: "organization", metadata: noMetadata },
  "member.added": {
    entityType: "membership",
    metadata: z.strictObject({ role }),
  },
  // An invitation is not a membership yet, and will have its own table.
  "member.invited": {
    entityType: "invitation",
    metadata: z.strictObject({ role }),
  },
  "member.role_changed": {
    entityType: "membership",
    metadata: z.strictObject({ fromRole: role, toRole: role }),
  },
  "member.removed": {
    entityType: "membership",
    metadata: z.strictObject({
      role,
      // "left" when members remove themselves, "removed" when a manager did.
      how: z.enum(["left", "removed"]),
    }),
  },
  "ai_system.created": { entityType: "ai_system", metadata: noMetadata },
  // Written by a database trigger (TASK-008): which columns changed, by
  // name, never their values.
  "ai_system.updated": {
    entityType: "ai_system",
    metadata: z.strictObject({
      fields: z
        .array(z.enum(["name", "description", "system_type", "provider"]))
        .min(1)
        .max(4)
        .refine((fields) => new Set(fields).size === fields.length),
    }),
  },
  "ai_system.archived": { entityType: "ai_system", metadata: noMetadata },
  "ai_system.unarchived": { entityType: "ai_system", metadata: noMetadata },
  // Written by database triggers (TASK-011), with no metadata: the hostname
  // stays out of the audit log.
  "deployment.created": { entityType: "deployment", metadata: noMetadata },
  "deployment.archived": { entityType: "deployment", metadata: noMetadata },
  "deployment.unarchived": { entityType: "deployment", metadata: noMetadata },
  "disclosure.published": { entityType: "disclosure", metadata: noMetadata },
  "report.generated": { entityType: "report", metadata: noMetadata },
  "billing.plan_changed": {
    entityType: "organization",
    metadata: z.strictObject({ fromPlan: plan, toPlan: plan }),
  },
} as const satisfies Record<
  string,
  { entityType: string; metadata: z.ZodType<Record<string, unknown>> }
>;

export type AuditEventType = keyof typeof AUDIT_EVENTS;

export type AuditEventMetadata<T extends AuditEventType> = z.input<
  (typeof AUDIT_EVENTS)[T]["metadata"]
>;

/** What a call site supplies. The actor and organization are not in it. */
export type AuditEvent = {
  [T in AuditEventType]: {
    type: T;
    entityId: string;
    metadata: AuditEventMetadata<T>;
  };
}[AuditEventType];

const entityIdSchema = z.uuid();

export type AuditEventRow = Readonly<{
  organization_id: string;
  actor_user_id: string;
  event_type: AuditEventType;
  entity_type: string;
  entity_id: string;
  metadata: Record<string, unknown>;
}>;

/**
 * Validates an event at runtime, since a cast or a spread can defeat the
 * types, and builds the row. Throws a `ZodError` for an unknown type, a bad
 * entity ID, or metadata outside its schema, an extra key included.
 */
export function toAuditEventRow(
  {
    organizationId,
    actorUserId,
  }: { organizationId: string; actorUserId: string },
  event: AuditEvent,
): AuditEventRow {
  const type = z
    .enum(Object.keys(AUDIT_EVENTS) as [AuditEventType, ...AuditEventType[]])
    .parse(event.type);
  const definition = AUDIT_EVENTS[type];

  return Object.freeze({
    organization_id: entityIdSchema.parse(organizationId),
    actor_user_id: entityIdSchema.parse(actorUserId),
    event_type: type,
    entity_type: definition.entityType,
    entity_id: entityIdSchema.parse(event.entityId),
    metadata: definition.metadata.parse(event.metadata),
  });
}
