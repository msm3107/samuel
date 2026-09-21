import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createTenantFixtures,
  freshSlug,
} from "@/tests/security/tenant-isolation/support/tenants";

/**
 * Schema and trigger invariants on `public.organizations` and
 * `public.memberships` (TASK-004), against real local Postgres with the
 * migration applied. RLS/grant behavior for the `authenticated` and `anon`
 * roles is covered separately in
 * tests/security/tenant-isolation/organizations.supabase.ts; this file
 * exercises constraints and triggers that hold for every role, service role
 * included.
 */

// One set of fixtures for the file, removed even when a test fails.
const fixtures = createTenantFixtures();

afterAll(async () => {
  await fixtures.cleanup();
});

describe("organizations and memberships schema constraints", () => {
  it("rejects a second membership for the same organization and user, even with a different role", async () => {
    const owner = await fixtures.createUser();
    const other = await fixtures.createUser();
    const org = await fixtures.createOrganization({ ownerId: owner.id });
    await fixtures.addMember(org.id, other.id, "member");

    const duplicate = await fixtures.admin.from("memberships").insert({
      organization_id: org.id,
      user_id: other.id,
      role: "admin",
    });
    expect(duplicate.error).not.toBeNull();
    expect(duplicate.error?.code).toBe("23505");
  });

  it("rejects a membership role outside owner, admin, member, or viewer", async () => {
    const owner = await fixtures.createUser();
    const other = await fixtures.createUser();
    const org = await fixtures.createOrganization({ ownerId: owner.id });

    const insert = await fixtures.admin.from("memberships").insert({
      organization_id: org.id,
      user_id: other.id,
      role: "superadmin",
    });
    expect(insert.error).not.toBeNull();
    expect(insert.error?.code).toBe("23514");
  });

  it.each([["Bad Slug"], ["-x-"], ["ab"]])(
    "rejects an organization slug that does not match the slug format: %s",
    async (slug) => {
      const insert = await fixtures.admin
        .from("organizations")
        .insert({ name: "Some Org", slug });
      expect(insert.error).not.toBeNull();
      expect(insert.error?.code).toBe("23514");
    },
  );

  it.each([
    ["", "empty"],
    ["x".repeat(121), "121 characters"],
    ["  Padded Name  ", "leading/trailing whitespace"],
  ])("rejects an organization name that is %s (%s)", async (name) => {
    const insert = await fixtures.admin
      .from("organizations")
      .insert({ name, slug: freshSlug() });
    expect(insert.error).not.toBeNull();
    expect(insert.error?.code).toBe("23514");
  });

  it("does not let the last owner remove their own membership, from their own client or from the service role", async () => {
    const owner = await fixtures.createUser();
    const org = await fixtures.createOrganization({ ownerId: owner.id });
    const ownerClient = await fixtures.signedInClient(owner);

    const selfDelete = await ownerClient
      .from("memberships")
      .delete()
      .eq("id", org.ownerMembershipId);
    expect(selfDelete.error).not.toBeNull();
    expect(selfDelete.error?.code).toBe("23514");

    const serviceDelete = await fixtures.admin
      .from("memberships")
      .delete()
      .eq("id", org.ownerMembershipId);
    expect(serviceDelete.error).not.toBeNull();
    expect(serviceDelete.error?.code).toBe("23514");

    const reread = await fixtures.admin
      .from("memberships")
      .select("id")
      .eq("id", org.ownerMembershipId)
      .single();
    expect(reread.data?.id).toBe(org.ownerMembershipId);
  });

  it("does not let the last owner be demoted away from the owner role", async () => {
    const owner = await fixtures.createUser();
    const org = await fixtures.createOrganization({ ownerId: owner.id });

    const demote = await fixtures.admin
      .from("memberships")
      .update({ role: "admin" })
      .eq("id", org.ownerMembershipId);
    expect(demote.error).not.toBeNull();
    expect(demote.error?.code).toBe("23514");

    const reread = await fixtures.admin
      .from("memberships")
      .select("role")
      .eq("id", org.ownerMembershipId)
      .single();
    expect(reread.data?.role).toBe("owner");
  });

  it("lets one of two owners be removed, but then refuses to remove the remaining sole owner", async () => {
    const ownerX = await fixtures.createUser();
    const ownerY = await fixtures.createUser();
    const org = await fixtures.createOrganization({ ownerId: ownerX.id });
    const ownerYMembership = await fixtures.addMember(
      org.id,
      ownerY.id,
      "owner",
    );

    const firstRemoval = await fixtures.admin
      .from("memberships")
      .delete()
      .eq("id", org.ownerMembershipId);
    expect(firstRemoval.error).toBeNull();

    const secondRemoval = await fixtures.admin
      .from("memberships")
      .delete()
      .eq("id", ownerYMembership.id);
    expect(secondRemoval.error).not.toBeNull();
    expect(secondRemoval.error?.code).toBe("23514");

    const reread = await fixtures.admin
      .from("memberships")
      .select("id")
      .eq("id", ownerYMembership.id)
      .single();
    expect(reread.data?.id).toBe(ownerYMembership.id);
  });

  it("lets only one of two owners win when each demotes the other at the same time", async () => {
    const ownerX = await fixtures.createUser();
    const ownerY = await fixtures.createUser();
    const org = await fixtures.createOrganization({ ownerId: ownerX.id });
    const ownerYMembership = await fixtures.addMember(
      org.id,
      ownerY.id,
      "owner",
    );
    const clientX = await fixtures.signedInClient(ownerX);
    const clientY = await fixtures.signedInClient(ownerY);

    const [xDemotesY, yDemotesX] = await Promise.all([
      clientX
        .from("memberships")
        .update({ role: "admin" })
        .eq("id", ownerYMembership.id)
        .select(),
      clientY
        .from("memberships")
        .update({ role: "admin" })
        .eq("id", org.ownerMembershipId)
        .select(),
    ]);

    // The organization row lock serializes the two: the second trigger sees
    // the first demotion and refuses, or its USING clause no longer matches
    // because its caller is no longer an owner.
    const succeeded = [xDemotesY, yDemotesX].filter(
      (result) => result.error === null && (result.data ?? []).length === 1,
    );
    expect(succeeded).toHaveLength(1);

    const owners = await fixtures.admin
      .from("memberships")
      .select("id")
      .eq("organization_id", org.id)
      .eq("role", "owner");
    expect(owners.data).toHaveLength(1);
  });

  it("removes an organization's memberships when the organization row is deleted", async () => {
    const owner = await fixtures.createUser();
    const org = await fixtures.createOrganization({ ownerId: owner.id });

    const deleteOrg = await fixtures.admin
      .from("organizations")
      .delete()
      .eq("id", org.id);
    expect(deleteOrg.error).toBeNull();

    const reread = await fixtures.admin
      .from("memberships")
      .select("*")
      .eq("organization_id", org.id);
    expect(reread.data).toEqual([]);
  });

  it("sets updated_at on update, ignoring whatever value the client sends", async () => {
    const owner = await fixtures.createUser();
    const org = await fixtures.createOrganization({ ownerId: owner.id });

    const before = await fixtures.admin
      .from("organizations")
      .select("created_at, updated_at")
      .eq("id", org.id)
      .single();
    expect(before.data).not.toBeNull();

    const staleTimestamp = new Date(0).toISOString();
    const update = await fixtures.admin
      .from("organizations")
      .update({ name: "Renamed Org", updated_at: staleTimestamp })
      .eq("id", org.id)
      .select("created_at, updated_at")
      .single();
    expect(update.error).toBeNull();
    expect(update.data?.updated_at).not.toBe(staleTimestamp);
    expect(
      new Date(update.data?.updated_at as string).getTime(),
    ).toBeGreaterThan(new Date(before.data?.created_at as string).getTime());
  });
});
