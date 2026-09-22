import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import {
  AUDIT_EVENTS,
  toAuditEventRow,
  type AuditEvent,
  type AuditEventType,
} from "@/features/organizations/audit/audit-events";

/**
 * Unit coverage for `toAuditEventRow` (TASK-006): no database, pure
 * validation. The event-type list is written out literally three times on
 * purpose — here, in `AUDIT_EVENTS`, and in the migrations' CHECK constraint
 * — and this file asserts all three agree, so a type added in one place and
 * forgotten in another fails loudly instead of drifting quietly.
 */

const REPOSITORY_ROOT = join(__dirname, "..", "..", "..");
const MIGRATIONS_DIRECTORY = join(REPOSITORY_ROOT, "supabase", "migrations");

/**
 * The list inside the most recent definition of `constraintName`, across
 * every migration in the order they apply: a later migration that redefines
 * the constraint is the one the database ends up with.
 */
function latestCheckList(constraintName: string, column: string): string[] {
  const pattern = new RegExp(
    `${constraintName} check \\(\\s*${column} in \\(([\\s\\S]*?)\\)\\s*\\)`,
    "g",
  );
  const lists = readdirSync(MIGRATIONS_DIRECTORY)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .flatMap((file) => [
      ...readFileSync(join(MIGRATIONS_DIRECTORY, file), "utf8").matchAll(
        pattern,
      ),
    ])
    .map((match) => match[1] ?? "");
  expect(lists.length).toBeGreaterThan(0);

  return (lists.at(-1) ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => entry.replace(/^'|'$/g, ""));
}

// The types the migrations' `audit_events_event_type_check` constraint
// allows, written literally (README §6 lists eight of these as examples;
// member.added and member.removed complete the set used by membership
// management, and the ai_system and deployment changes are audited by
// trigger, TASK-008 and TASK-011).
const EVENT_TYPES = [
  "organization.created",
  "member.added",
  "member.invited",
  "member.role_changed",
  "member.removed",
  "ai_system.created",
  "ai_system.updated",
  "ai_system.archived",
  "ai_system.unarchived",
  "deployment.created",
  "deployment.archived",
  "deployment.unarchived",
  "disclosure.published",
  "report.generated",
  "billing.plan_changed",
] as const satisfies readonly AuditEventType[];

const ENTITY_TYPE_BY_EVENT: Record<(typeof EVENT_TYPES)[number], string> = {
  "organization.created": "organization",
  "member.added": "membership",
  "member.invited": "invitation",
  "member.role_changed": "membership",
  "member.removed": "membership",
  "ai_system.created": "ai_system",
  "ai_system.updated": "ai_system",
  "ai_system.archived": "ai_system",
  "ai_system.unarchived": "ai_system",
  "deployment.created": "deployment",
  "deployment.archived": "deployment",
  "deployment.unarchived": "deployment",
  "disclosure.published": "disclosure",
  "report.generated": "report",
  "billing.plan_changed": "organization",
};

/** Metadata that satisfies each type's Zod schema, for building valid events. */
function validMetadata(
  type: (typeof EVENT_TYPES)[number],
): Record<string, unknown> {
  switch (type) {
    case "organization.created":
    case "ai_system.created":
    case "ai_system.archived":
    case "ai_system.unarchived":
    case "deployment.created":
    case "deployment.archived":
    case "deployment.unarchived":
    case "disclosure.published":
    case "report.generated":
      return {};
    case "member.added":
    case "member.invited":
      return { role: "member" };
    case "member.role_changed":
      return { fromRole: "member", toRole: "admin" };
    case "ai_system.updated":
      return { fields: ["name", "provider"] };
    case "member.removed":
      return { role: "member", how: "left" };
    case "billing.plan_changed":
      return { fromPlan: "none", toPlan: "founder" };
  }
}

function baseIds() {
  return {
    organizationId: randomUUID(),
    actorUserId: randomUUID(),
  };
}

function validEvent(type: (typeof EVENT_TYPES)[number]): AuditEvent {
  return {
    type,
    entityId: randomUUID(),
    metadata: validMetadata(type),
  } as AuditEvent;
}

describe("AUDIT_EVENTS and the migration's CHECK constraint stay in step", () => {
  it("AUDIT_EVENTS has exactly the literal event types", () => {
    expect(Object.keys(AUDIT_EVENTS).sort()).toEqual([...EVENT_TYPES].sort());
  });

  it("the migrations' latest event_type CHECK constraint lists exactly the same types", () => {
    const listed = latestCheckList(
      "audit_events_event_type_check",
      "event_type",
    );

    expect(listed.sort()).toEqual([...EVENT_TYPES].sort());
    expect(listed.sort()).toEqual(Object.keys(AUDIT_EVENTS).sort());
  });

  it("the migrations' latest entity_type CHECK constraint lists exactly the entity types AUDIT_EVENTS uses", () => {
    const listed = latestCheckList(
      "audit_events_entity_type_check",
      "entity_type",
    );
    const used = new Set(
      Object.values(AUDIT_EVENTS).map(({ entityType }) => entityType),
    );

    expect(listed.sort()).toEqual([...used].sort());
  });
});

describe("toAuditEventRow: entity types", () => {
  it.each(Object.entries(ENTITY_TYPE_BY_EVENT))(
    "%s builds a row with entity_type %s",
    (type, expectedEntityType) => {
      const ids = baseIds();
      const row = toAuditEventRow(ids, validEvent(type as AuditEventType));

      expect(row.entity_type).toBe(expectedEntityType);
      expect(row.event_type).toBe(type);
      expect(row.organization_id).toBe(ids.organizationId);
      expect(row.actor_user_id).toBe(ids.actorUserId);
    },
  );
});

describe("README §6 examples are all representable", () => {
  const readmeExamples = [
    "organization.created",
    "member.invited",
    "member.role_changed",
    "ai_system.created",
    "deployment.created",
    "disclosure.published",
    "report.generated",
    "billing.plan_changed",
  ] as const satisfies readonly AuditEventType[];

  it.each(readmeExamples)("%s builds a valid row", (type) => {
    const row = toAuditEventRow(baseIds(), validEvent(type));
    expect(row.event_type).toBe(type);
  });
});

describe("toAuditEventRow: rejects token-shaped and otherwise unsafe metadata", () => {
  const tokenShapedKeys = [
    "accessToken",
    "password",
    "authorization",
    "cookie",
    "refreshToken",
    "email",
    "card",
    "stripeSignature",
  ];

  it.each(
    EVENT_TYPES.flatMap((type) =>
      tokenShapedKeys.map((key) => [type, key] as const),
    ),
  )("%s rejects metadata carrying an extra %s field", (type, key) => {
    const pollutedMetadata = {
      ...validMetadata(type),
      [key]: "eyJhbGciOiJIUzI1NiJ9.polluted.value",
    };

    expect(() =>
      toAuditEventRow(baseIds(), {
        type,
        entityId: randomUUID(),
        metadata: pollutedMetadata,
      } as AuditEvent),
    ).toThrow(ZodError);
  });

  it("rejects the representative member.role_changed payload carrying an access token", () => {
    expect(() =>
      toAuditEventRow(baseIds(), {
        type: "member.role_changed",
        entityId: randomUUID(),
        metadata: {
          fromRole: "member",
          toRole: "admin",
          accessToken: "eyJhbGciOi.forged.token",
        },
      } as AuditEvent),
    ).toThrow(ZodError);
  });

  it("rejects token-shaped role and plan VALUES, not just extra keys", () => {
    expect(() =>
      toAuditEventRow(baseIds(), {
        type: "member.role_changed",
        entityId: randomUUID(),
        metadata: { fromRole: "Bearer abc", toRole: "admin" },
      } as unknown as AuditEvent),
    ).toThrow(ZodError);

    expect(() =>
      toAuditEventRow(baseIds(), {
        type: "billing.plan_changed",
        entityId: randomUUID(),
        metadata: { fromPlan: "sk_live_51H8xyz", toPlan: "founder" },
      } as unknown as AuditEvent),
    ).toThrow(ZodError);
  });
});

describe("toAuditEventRow: rejects malformed identifiers and unknown types", () => {
  it("rejects a non-uuid organizationId", () => {
    expect(() =>
      toAuditEventRow(
        { organizationId: "not-a-uuid", actorUserId: randomUUID() },
        validEvent("organization.created"),
      ),
    ).toThrow(ZodError);
  });

  it("rejects a non-uuid actorUserId", () => {
    expect(() =>
      toAuditEventRow(
        { organizationId: randomUUID(), actorUserId: "not-a-uuid" },
        validEvent("organization.created"),
      ),
    ).toThrow(ZodError);
  });

  it("rejects a non-uuid entityId", () => {
    expect(() =>
      toAuditEventRow(baseIds(), {
        type: "organization.created",
        entityId: "not-a-uuid",
        metadata: {},
      } as AuditEvent),
    ).toThrow(ZodError);
  });

  it("rejects an unknown event type supplied via a cast", () => {
    expect(() =>
      toAuditEventRow(baseIds(), {
        type: "not.a.real.type",
        entityId: randomUUID(),
        metadata: {},
      } as unknown as AuditEvent),
    ).toThrow(ZodError);
  });

  it.each(["constructor", "__proto__", "hasOwnProperty", "toString"])(
    "rejects %s used as the event type",
    (type) => {
      expect(() =>
        toAuditEventRow(baseIds(), {
          type,
          entityId: randomUUID(),
          metadata: {},
        } as unknown as AuditEvent),
      ).toThrow(ZodError);
    },
  );
});

describe("toAuditEventRow: the returned row", () => {
  it("is frozen and contains exactly the expected keys", () => {
    const row = toAuditEventRow(baseIds(), validEvent("organization.created"));

    expect(Object.isFrozen(row)).toBe(true);
    expect(Object.keys(row).sort()).toEqual(
      [
        "organization_id",
        "actor_user_id",
        "event_type",
        "entity_type",
        "entity_id",
        "metadata",
      ].sort(),
    );
    expect(row).not.toHaveProperty("id");
    expect(row).not.toHaveProperty("created_at");
  });

  it("cannot be mutated after being built", () => {
    const row = toAuditEventRow(baseIds(), validEvent("organization.created"));

    expect(() => {
      (row as { event_type: string }).event_type = "member.added";
    }).toThrow();
  });
});

describe("ai_system.updated metadata", () => {
  it.each([
    ["no fields", { fields: [] }],
    ["a repeated field", { fields: ["name", "name"] }],
    ["an unknown field", { fields: ["status"] }],
    ["a value instead of a name", { fields: ["Support Bot"] }],
    [
      "the changed values themselves",
      { fields: ["name"], name: "Support Bot" },
    ],
  ])("refuses %s", (_label, metadata) => {
    expect(() =>
      toAuditEventRow(baseIds(), {
        type: "ai_system.updated",
        entityId: randomUUID(),
        metadata,
      } as unknown as AuditEvent),
    ).toThrow(ZodError);
  });
});
