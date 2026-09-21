import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { SupabaseClient } from "@supabase/supabase-js";

import type { OrganizationAccess } from "@/lib/auth/require-organization-role";

import {
  anonClient,
  createTenantFixtures,
  type TestOrganization,
  type TestUser,
} from "@/tests/security/tenant-isolation/support/tenants";
import { recordAuditEvent } from "@/features/organizations/audit/record-audit-event";

/**
 * `public.audit_events` (TASK-006) against real local Postgres: append-only
 * enforcement, cross-tenant isolation, soft-delete visibility, cascade on
 * organization deletion, the `created_at` trigger, and the CHECK constraints
 * that bound `event_type`, `entity_type` and `metadata`.
 *
 * Row/RLS test helpers insert directly through the service-role `admin`
 * client so each row's shape is fully controlled; one row is also written
 * through the real `recordAuditEvent` (only `server-only` is mocked, so this
 * exercises the actual service-role client and the actual Zod validation
 * against the real database, not a stand-in for either).
 */

interface AuditEventRow {
  id: string;
  organization_id: string;
  actor_user_id: string;
  event_type: string;
  entity_type: string;
  entity_id: string;
  metadata: Record<string, unknown>;
  created_at: string;
}

const fixtures = createTenantFixtures();

let ownerA: TestUser;
let adminA: TestUser;
let memberA: TestUser;
let viewerA: TestUser;
let orgA: TestOrganization;
let ownerAClient: SupabaseClient;
let adminAClient: SupabaseClient;
let memberAClient: SupabaseClient;
let viewerAClient: SupabaseClient;

let ownerB: TestUser;
let orgB: TestOrganization;

let orgAEventId: string;
let orgBEventId: string;

async function insertEvent(options: {
  organizationId: string;
  actorUserId?: string;
  eventType?: string;
  entityType?: string;
  entityId?: string;
  metadata?: unknown;
  createdAt?: string;
}): Promise<{ data: AuditEventRow | null; error: { code?: string } | null }> {
  const { data, error } = await fixtures.admin
    .from("audit_events")
    .insert({
      organization_id: options.organizationId,
      actor_user_id: options.actorUserId ?? randomUUID(),
      event_type: options.eventType ?? "organization.created",
      entity_type: options.entityType ?? "organization",
      entity_id: options.entityId ?? options.organizationId,
      metadata: options.metadata ?? {},
      ...(options.createdAt ? { created_at: options.createdAt } : {}),
    })
    .select()
    .single();
  return { data: data as AuditEventRow | null, error };
}

beforeAll(async () => {
  ownerA = await fixtures.createUser();
  orgA = await fixtures.createOrganization({ ownerId: ownerA.id });
  ownerAClient = await fixtures.signedInClient(ownerA);

  adminA = await fixtures.createUser();
  await fixtures.addMember(orgA.id, adminA.id, "admin");
  adminAClient = await fixtures.signedInClient(adminA);

  memberA = await fixtures.createUser();
  await fixtures.addMember(orgA.id, memberA.id, "member");
  memberAClient = await fixtures.signedInClient(memberA);

  viewerA = await fixtures.createUser();
  await fixtures.addMember(orgA.id, viewerA.id, "viewer");
  viewerAClient = await fixtures.signedInClient(viewerA);

  ownerB = await fixtures.createUser();
  orgB = await fixtures.createOrganization({ ownerId: ownerB.id });

  const orgAEvent = await insertEvent({
    organizationId: orgA.id,
    actorUserId: ownerA.id,
    eventType: "organization.created",
    entityType: "organization",
    entityId: orgA.id,
  });
  if (orgAEvent.error || !orgAEvent.data) {
    throw new Error(
      `failed to seed org A event: ${JSON.stringify(orgAEvent.error)}`,
    );
  }
  orgAEventId = orgAEvent.data.id;

  // A second org A event, written through the real recordAuditEvent path
  // (real service-role client, real Zod validation) rather than the raw
  // admin insert above.
  const access: OrganizationAccess = Object.freeze({
    userId: ownerA.id,
    organizationId: orgA.id,
    role: "owner",
  });
  const recorded = await recordAuditEvent(access, {
    type: "ai_system.created",
    entityId: randomUUID(),
    metadata: {},
  });
  expect(recorded).toEqual({ recorded: true });

  const orgBEvent = await insertEvent({
    organizationId: orgB.id,
    actorUserId: ownerB.id,
    eventType: "organization.created",
    entityType: "organization",
    entityId: orgB.id,
  });
  if (orgBEvent.error || !orgBEvent.data) {
    throw new Error(
      `failed to seed org B event: ${JSON.stringify(orgBEvent.error)}`,
    );
  }
  orgBEventId = orgBEvent.data.id;
}, 30_000);

afterAll(async () => {
  await fixtures.cleanup();
});

describe("audit_events: append-only", () => {
  it("refuses an update from the authenticated owner, and the row is unchanged", async () => {
    const update = await ownerAClient
      .from("audit_events")
      .update({ event_type: "member.removed" })
      .eq("id", orgAEventId);
    expect(update.error).not.toBeNull();
    expect(update.error?.code).toBe("42501");

    const reread = await fixtures.admin
      .from("audit_events")
      .select("event_type")
      .eq("id", orgAEventId)
      .single();
    expect(reread.data?.event_type).toBe("organization.created");
  });

  it("refuses a delete from the authenticated owner, and the row is still present", async () => {
    const del = await ownerAClient
      .from("audit_events")
      .delete()
      .eq("id", orgAEventId);
    expect(del.error).not.toBeNull();
    expect(del.error?.code).toBe("42501");

    const reread = await fixtures.admin
      .from("audit_events")
      .select("id")
      .eq("id", orgAEventId)
      .single();
    expect(reread.data?.id).toBe(orgAEventId);
  });

  it("refuses an update from the service-role client itself, and the row is unchanged", async () => {
    const update = await fixtures.admin
      .from("audit_events")
      .update({ event_type: "member.removed" })
      .eq("id", orgAEventId);
    expect(update.error).not.toBeNull();
    expect(update.error?.code).toBe("42501");

    const reread = await fixtures.admin
      .from("audit_events")
      .select("event_type")
      .eq("id", orgAEventId)
      .single();
    expect(reread.data?.event_type).toBe("organization.created");
  });

  it("refuses a delete from the service-role client itself, and the row is still present", async () => {
    const del = await fixtures.admin
      .from("audit_events")
      .delete()
      .eq("id", orgAEventId);
    expect(del.error).not.toBeNull();
    expect(del.error?.code).toBe("42501");

    const reread = await fixtures.admin
      .from("audit_events")
      .select("id")
      .eq("id", orgAEventId)
      .single();
    expect(reread.data?.id).toBe(orgAEventId);
  });

  it("refuses an insert from the authenticated owner: a user cannot forge history", async () => {
    const insert = await ownerAClient.from("audit_events").insert({
      organization_id: orgA.id,
      actor_user_id: ownerA.id,
      event_type: "organization.created",
      entity_type: "organization",
      entity_id: orgA.id,
      metadata: {},
    });
    expect(insert.error).not.toBeNull();
    expect(insert.error?.code).toBe("42501");
  });

  it("refuses anon select and insert entirely", async () => {
    const anon = anonClient();

    const select = await anon.from("audit_events").select("*");
    expect(select.error?.code).toBe("42501");
    expect(select.data).toBeNull();

    const insert = await anon.from("audit_events").insert({
      organization_id: orgA.id,
      actor_user_id: randomUUID(),
      event_type: "organization.created",
      entity_type: "organization",
      entity_id: orgA.id,
      metadata: {},
    });
    expect(insert.error?.code).toBe("42501");
  });
});

describe("audit_events: cross-tenant isolation and role-scoped reads", () => {
  it("does not let organization A's owner read organization B's events, by id or by filter", async () => {
    const byId = await ownerAClient
      .from("audit_events")
      .select("*")
      .eq("id", orgBEventId);
    expect(byId.error).toBeNull();
    expect(byId.data).toEqual([]);

    const filtered = await ownerAClient
      .from("audit_events")
      .select("*")
      .eq("organization_id", orgB.id);
    expect(filtered.error).toBeNull();
    expect(filtered.data).toEqual([]);
  });

  it("lets organization A's owner and admin see organization A's events", async () => {
    const asOwner = await ownerAClient
      .from("audit_events")
      .select("*")
      .eq("organization_id", orgA.id);
    expect(asOwner.error).toBeNull();
    expect((asOwner.data ?? []).length).toBeGreaterThan(0);

    const asAdmin = await adminAClient
      .from("audit_events")
      .select("*")
      .eq("organization_id", orgA.id);
    expect(asAdmin.error).toBeNull();
    expect((asAdmin.data ?? []).length).toBeGreaterThan(0);
  });

  it("does not let a member or a viewer of organization A see any audit events", async () => {
    const asMember = await memberAClient
      .from("audit_events")
      .select("*")
      .eq("organization_id", orgA.id);
    expect(asMember.error).toBeNull();
    expect(asMember.data).toEqual([]);

    const asViewer = await viewerAClient
      .from("audit_events")
      .select("*")
      .eq("organization_id", orgA.id);
    expect(asViewer.error).toBeNull();
    expect(asViewer.data).toEqual([]);
  });

  it("hides organization A's events from its owner once the organization is soft-deleted", async () => {
    const softDelete = await fixtures.admin
      .from("organizations")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", orgA.id);
    expect(softDelete.error).toBeNull();

    try {
      const result = await ownerAClient
        .from("audit_events")
        .select("*")
        .eq("organization_id", orgA.id);
      expect(result.error).toBeNull();
      expect(result.data).toEqual([]);
    } finally {
      // Restore, so later tests (and the RLS/append-only tests above, if
      // vitest ever reordered them) keep seeing an undeleted organization A.
      const restore = await fixtures.admin
        .from("organizations")
        .update({ deleted_at: null })
        .eq("id", orgA.id);
      expect(restore.error).toBeNull();
    }
  });
});

describe("audit_events: rows disappear only with their organization", () => {
  it("removes an organization's events when the organization itself is deleted (cascade)", async () => {
    const throwawayOwner = await fixtures.createUser();
    const throwawayOrg = await fixtures.createOrganization({
      ownerId: throwawayOwner.id,
    });
    const seeded = await insertEvent({
      organizationId: throwawayOrg.id,
      actorUserId: throwawayOwner.id,
    });
    expect(seeded.error).toBeNull();

    const before = await fixtures.admin
      .from("audit_events")
      .select("id")
      .eq("organization_id", throwawayOrg.id);
    expect((before.data ?? []).length).toBe(1);

    const deleteOrg = await fixtures.admin
      .from("organizations")
      .delete()
      .eq("id", throwawayOrg.id);
    expect(deleteOrg.error).toBeNull();

    const after = await fixtures.admin
      .from("audit_events")
      .select("id")
      .eq("organization_id", throwawayOrg.id);
    expect(after.error).toBeNull();
    expect(after.data).toEqual([]);
  });
});

describe("audit_events: created_at is the database's, not the writer's", () => {
  it("overrides a supplied created_at with the actual insert time", async () => {
    const before = Date.now();
    const inserted = await insertEvent({
      organizationId: orgA.id,
      actorUserId: ownerA.id,
      createdAt: "2000-01-01T00:00:00.000Z",
    });
    expect(inserted.error).toBeNull();
    const storedAt = new Date(inserted.data?.created_at ?? "").getTime();

    expect(storedAt).toBeGreaterThanOrEqual(before - 5_000);
    expect(storedAt).toBeLessThanOrEqual(Date.now() + 5_000);
  });
});

describe("audit_events: CHECK constraints", () => {
  it("rejects an event_type outside the known set", async () => {
    const result = await insertEvent({
      organizationId: orgA.id,
      eventType: "totally.unknown.event",
    });
    expect(result.error?.code).toBe("23514");
  });

  it("rejects an entity_type outside the known set", async () => {
    const result = await insertEvent({
      organizationId: orgA.id,
      entityType: "not_a_real_entity",
    });
    expect(result.error?.code).toBe("23514");
  });

  it("rejects metadata that is not a JSON object", async () => {
    const result = await insertEvent({
      organizationId: orgA.id,
      metadata: [],
    });
    expect(result.error?.code).toBe("23514");
  });

  it("rejects metadata larger than 2048 bytes as text", async () => {
    const result = await insertEvent({
      organizationId: orgA.id,
      metadata: { padding: "a".repeat(3000) },
    });
    expect(result.error?.code).toBe("23514");
  });
});
