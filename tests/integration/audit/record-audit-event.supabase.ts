import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { OrganizationAccess } from "@/lib/auth/require-organization-role";

import { createTenantFixtures } from "@/tests/security/tenant-isolation/support/tenants";
import { recordAuditEvent } from "@/features/organizations/audit/record-audit-event";

/**
 * `recordAuditEvent` (TASK-006) against real local Postgres, with the real
 * service-role client (only `server-only` is mocked — the module doing the
 * insert is the real one, not a fake table).
 */

const fixtures = createTenantFixtures();

afterAll(async () => {
  await fixtures.cleanup();
});

async function eventCountFor(organizationId: string): Promise<number> {
  const { count, error } = await fixtures.admin
    .from("audit_events")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId);
  if (error) {
    throw error;
  }
  return count ?? 0;
}

describe("recordAuditEvent: recorded rows are correct", () => {
  it("records actor, organization, event type, entity type, entity id and metadata correctly", async () => {
    const owner = await fixtures.createUser();
    const org = await fixtures.createOrganization({ ownerId: owner.id });
    const access: OrganizationAccess = Object.freeze({
      userId: owner.id,
      organizationId: org.id,
      role: "owner",
    });
    const entityId = randomUUID();

    const result = await recordAuditEvent(access, {
      type: "member.role_changed",
      entityId,
      metadata: { fromRole: "member", toRole: "admin" },
    });

    expect(result).toEqual({ recorded: true });

    const { data, error } = await fixtures.admin
      .from("audit_events")
      .select("*")
      .eq("organization_id", org.id)
      .eq("entity_id", entityId)
      .single();
    expect(error).toBeNull();
    expect(data).toMatchObject({
      organization_id: org.id,
      actor_user_id: owner.id,
      event_type: "member.role_changed",
      entity_type: "membership",
      entity_id: entityId,
      metadata: { fromRole: "member", toRole: "admin" },
    });
  });

  it("records organization.created and member.added for a fresh organization", async () => {
    const owner = await fixtures.createUser();
    const org = await fixtures.createOrganization({ ownerId: owner.id });
    const access: OrganizationAccess = Object.freeze({
      userId: owner.id,
      organizationId: org.id,
      role: "owner",
    });

    const created = await recordAuditEvent(access, {
      type: "organization.created",
      entityId: org.id,
      metadata: {},
    });
    expect(created).toEqual({ recorded: true });

    const newMembershipId = randomUUID();
    const added = await recordAuditEvent(access, {
      type: "member.added",
      entityId: newMembershipId,
      metadata: { role: "member" },
    });
    expect(added).toEqual({ recorded: true });

    const { data, error } = await fixtures.admin
      .from("audit_events")
      .select("event_type, entity_type, entity_id, metadata")
      .eq("organization_id", org.id)
      .order("event_type", { ascending: true });
    expect(error).toBeNull();
    expect(data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event_type: "organization.created",
          entity_type: "organization",
          entity_id: org.id,
        }),
        expect.objectContaining({
          event_type: "member.added",
          entity_type: "membership",
          entity_id: newMembershipId,
          metadata: { role: "member" },
        }),
      ]),
    );
  });
});

describe("recordAuditEvent: invalid metadata inserts nothing", () => {
  it("returns {recorded: false} and leaves the row count unchanged", async () => {
    const owner = await fixtures.createUser();
    const org = await fixtures.createOrganization({ ownerId: owner.id });
    const access: OrganizationAccess = Object.freeze({
      userId: owner.id,
      organizationId: org.id,
      role: "owner",
    });

    const before = await eventCountFor(org.id);

    const result = await recordAuditEvent(access, {
      type: "member.role_changed",
      entityId: randomUUID(),
      metadata: {
        fromRole: "member",
        toRole: "admin",
        accessToken: "eyJhbGciOi.forged.token",
      },
    } as unknown as Parameters<typeof recordAuditEvent>[1]);

    expect(result).toEqual({ recorded: false });
    expect(await eventCountFor(org.id)).toBe(before);
  });
});
