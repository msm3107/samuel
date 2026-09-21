import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  anonClient,
  createTenantFixtures,
  type TestOrganization,
  type TestUser,
} from "@/tests/security/tenant-isolation/support/tenants";

/**
 * RLS on `public.organizations` and `public.memberships` (TASK-004), against
 * real local Postgres with the migration applied.
 *
 * README §8 lists five checks. This file covers the first three directly:
 *   - read:      "user A cannot read org B" below.
 *   - update:    "user A cannot update org B" below.
 *   - enumerate: "user A cannot enumerate org B ids" below.
 * The other two are application-level, in organizations-api.supabase.ts
 * (TASK-007): all five checks through the API routes, and "generate reports
 * for org B" through the permission check that report generation will use.
 * Reports themselves need their own suite once the feature exists.
 */

const fixtures = createTenantFixtures();

let userA: TestUser;
let userB: TestUser;
let orgA: TestOrganization;
let orgB: TestOrganization;
let ownerClient: SupabaseClient;

let adminUser: TestUser;
let memberUser: TestUser;
let anotherMemberUser: TestUser;
let viewerUser: TestUser;
let adminClient: SupabaseClient;
let memberClient: SupabaseClient;
let viewerClient: SupabaseClient;

let anotherMemberMembershipId: string;
let viewerMembershipId: string;

beforeAll(async () => {
  userA = await fixtures.createUser();
  userB = await fixtures.createUser();
  orgA = await fixtures.createOrganization({ ownerId: userA.id });
  orgB = await fixtures.createOrganization({ ownerId: userB.id });
  ownerClient = await fixtures.signedInClient(userA);

  adminUser = await fixtures.createUser();
  memberUser = await fixtures.createUser();
  anotherMemberUser = await fixtures.createUser();
  viewerUser = await fixtures.createUser();

  await fixtures.addMember(orgA.id, adminUser.id, "admin");
  await fixtures.addMember(orgA.id, memberUser.id, "member");
  const anotherMemberMembership = await fixtures.addMember(
    orgA.id,
    anotherMemberUser.id,
    "member",
  );
  anotherMemberMembershipId = anotherMemberMembership.id;
  const viewerMembership = await fixtures.addMember(
    orgA.id,
    viewerUser.id,
    "viewer",
  );
  viewerMembershipId = viewerMembership.id;

  adminClient = await fixtures.signedInClient(adminUser);
  memberClient = await fixtures.signedInClient(memberUser);
  viewerClient = await fixtures.signedInClient(viewerUser);
});

afterAll(async () => {
  await fixtures.cleanup();
});

describe("tenant isolation: organizations and memberships", () => {
  it("does not let user A read organization B by id, and lists only organization A", async () => {
    const byId = await ownerClient
      .from("organizations")
      .select("*")
      .eq("id", orgB.id);
    expect(byId.error).toBeNull();
    expect(byId.data).toEqual([]);

    const all = await ownerClient.from("organizations").select("*");
    expect(all.error).toBeNull();
    expect((all.data ?? []).map((row) => (row as { id: string }).id)).toEqual([
      orgA.id,
    ]);
  });

  it("does not let user A read organization B's memberships", async () => {
    const result = await ownerClient
      .from("memberships")
      .select("*")
      .eq("organization_id", orgB.id);
    expect(result.error).toBeNull();
    expect(result.data).toEqual([]);
  });

  it("does not let user A update organization B's name", async () => {
    const update = await ownerClient
      .from("organizations")
      .update({ name: "Hijacked" })
      .eq("id", orgB.id)
      .select();
    expect(update.error).toBeNull();
    expect(update.data).toEqual([]);

    const reread = await fixtures.admin
      .from("organizations")
      .select("name")
      .eq("id", orgB.id)
      .single();
    expect(reread.data?.name).toBe(orgB.name);
  });

  it("does not let user A delete a membership in organization B", async () => {
    const del = await ownerClient
      .from("memberships")
      .delete()
      .eq("id", orgB.ownerMembershipId)
      .select();
    expect(del.error).toBeNull();
    expect(del.data).toEqual([]);

    const reread = await fixtures.admin
      .from("memberships")
      .select("id")
      .eq("id", orgB.ownerMembershipId)
      .single();
    expect(reread.data?.id).toBe(orgB.ownerMembershipId);
  });

  it("does not let user A enumerate organization B's id through listing or filtering", async () => {
    const orgs = await ownerClient.from("organizations").select("id");
    expect(
      (orgs.data ?? []).some((row) => (row as { id: string }).id === orgB.id),
    ).toBe(false);

    const memberships = await ownerClient.from("memberships").select("*");
    expect(
      (memberships.data ?? []).some(
        (row) =>
          (row as { organization_id: string }).organization_id === orgB.id,
      ),
    ).toBe(false);

    const filtered = await ownerClient
      .from("memberships")
      .select("*")
      .eq("organization_id", orgB.id);
    expect(filtered.data).toEqual([]);
  });

  it("does not let user A insert a membership into organization B, even granting themselves owner", async () => {
    const insert = await ownerClient.from("memberships").insert({
      organization_id: orgB.id,
      user_id: userA.id,
      role: "owner",
    });
    expect(insert.error).not.toBeNull();
    expect(insert.error?.code).toBe("42501");

    const reread = await fixtures.admin
      .from("memberships")
      .select("*")
      .eq("organization_id", orgB.id)
      .eq("user_id", userA.id);
    expect(reread.data).toEqual([]);
  });

  it("does not let user A insert an organization, since authenticated has no insert grant", async () => {
    const insert = await ownerClient
      .from("organizations")
      .insert({ name: "Rogue Org", slug: "rogue-org-should-not-exist" });
    expect(insert.error).not.toBeNull();
    expect(insert.error?.code).toBe("42501");
  });

  it("does not let the anon client read organizations or memberships", async () => {
    const anon = anonClient();

    const orgs = await anon.from("organizations").select("*");
    expect(orgs.error?.code).toBe("42501");
    expect(orgs.data).toBeNull();

    const memberships = await anon.from("memberships").select("*");
    expect(memberships.error?.code).toBe("42501");
    expect(memberships.data).toBeNull();
  });

  it("lets a viewer see organization A and their own membership", async () => {
    const org = await viewerClient
      .from("organizations")
      .select("*")
      .eq("id", orgA.id);
    expect(org.data).toHaveLength(1);

    const own = await viewerClient
      .from("memberships")
      .select("*")
      .eq("id", viewerMembershipId);
    expect(own.data).toHaveLength(1);
  });

  it("does not let a viewer of organization A rename the organization", async () => {
    const update = await viewerClient
      .from("organizations")
      .update({ name: "Viewer Renamed This" })
      .eq("id", orgA.id)
      .select();
    expect(update.error).toBeNull();
    expect(update.data).toEqual([]);

    const reread = await fixtures.admin
      .from("organizations")
      .select("name")
      .eq("id", orgA.id)
      .single();
    expect(reread.data?.name).toBe(orgA.name);
  });

  it("does not let a viewer change any membership role, including promoting themselves to owner", async () => {
    const update = await viewerClient
      .from("memberships")
      .update({ role: "owner" })
      .eq("id", viewerMembershipId)
      .select();
    expect(update.error).toBeNull();
    expect(update.data).toEqual([]);

    const reread = await fixtures.admin
      .from("memberships")
      .select("role")
      .eq("id", viewerMembershipId)
      .single();
    expect(reread.data?.role).toBe("viewer");
  });

  it("does not let a viewer delete another member's membership", async () => {
    const del = await viewerClient
      .from("memberships")
      .delete()
      .eq("id", anotherMemberMembershipId)
      .select();
    expect(del.error).toBeNull();
    expect(del.data).toEqual([]);

    const reread = await fixtures.admin
      .from("memberships")
      .select("id")
      .eq("id", anotherMemberMembershipId)
      .single();
    expect(reread.data?.id).toBe(anotherMemberMembershipId);
  });

  it("lets a member of organization A see their own membership but not other members'", async () => {
    const result = await memberClient
      .from("memberships")
      .select("*")
      .eq("organization_id", orgA.id);
    expect(result.error).toBeNull();
    const rows = (result.data ?? []) as { user_id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(memberUser.id);
  });

  it("does not let an admin change an owner's role", async () => {
    const update = await adminClient
      .from("memberships")
      .update({ role: "member" })
      .eq("id", orgA.ownerMembershipId)
      .select();
    expect(update.error).toBeNull();
    expect(update.data).toEqual([]);

    const reread = await fixtures.admin
      .from("memberships")
      .select("role")
      .eq("id", orgA.ownerMembershipId)
      .single();
    expect(reread.data?.role).toBe("owner");
  });

  it("does not let an admin promote anyone to owner", async () => {
    const update = await adminClient
      .from("memberships")
      .update({ role: "owner" })
      .eq("id", anotherMemberMembershipId)
      .select();
    // The new row fails the policy's WITH CHECK.
    expect(update.error?.code).toBe("42501");

    const reread = await fixtures.admin
      .from("memberships")
      .select("role")
      .eq("id", anotherMemberMembershipId)
      .single();
    expect(reread.data?.role).toBe("member");
  });

  it("does not let an admin delete an owner's membership", async () => {
    const del = await adminClient
      .from("memberships")
      .delete()
      .eq("id", orgA.ownerMembershipId)
      .select();
    expect(del.error).toBeNull();
    expect(del.data).toEqual([]);

    const reread = await fixtures.admin
      .from("memberships")
      .select("id")
      .eq("id", orgA.ownerMembershipId)
      .single();
    expect(reread.data?.id).toBe(orgA.ownerMembershipId);
  });

  it("lets an admin change a member's role to viewer", async () => {
    const update = await adminClient
      .from("memberships")
      .update({ role: "viewer" })
      .eq("id", anotherMemberMembershipId)
      .select();
    expect(update.error).toBeNull();
    expect(update.data).toHaveLength(1);

    const reread = await fixtures.admin
      .from("memberships")
      .select("role")
      .eq("id", anotherMemberMembershipId)
      .single();
    expect(reread.data?.role).toBe("viewer");
  });

  it("does not let user A change a membership's organization_id or user_id column", async () => {
    const changeOrg = await ownerClient
      .from("memberships")
      .update({ organization_id: orgB.id })
      .eq("id", orgA.ownerMembershipId);
    expect(changeOrg.error?.code).toBe("42501");

    const changeUser = await ownerClient
      .from("memberships")
      .update({ user_id: userB.id })
      .eq("id", orgA.ownerMembershipId);
    expect(changeUser.error?.code).toBe("42501");

    const reread = await fixtures.admin
      .from("memberships")
      .select("organization_id, user_id")
      .eq("id", orgA.ownerMembershipId)
      .single();
    expect(reread.data?.organization_id).toBe(orgA.id);
    expect(reread.data?.user_id).toBe(userA.id);
  });

  it("lets a member leave organization A by deleting their own membership", async () => {
    const leaver = await fixtures.createUser();
    const membership = await fixtures.addMember(orgA.id, leaver.id, "member");
    const leaverClient = await fixtures.signedInClient(leaver);

    const del = await leaverClient
      .from("memberships")
      .delete()
      .eq("id", membership.id)
      .select();
    expect(del.error).toBeNull();
    expect(del.data).toHaveLength(1);

    const reread = await fixtures.admin
      .from("memberships")
      .select("id")
      .eq("id", membership.id);
    expect(reread.data).toEqual([]);
  });

  it("does not let organization A's owner read it once it is soft-deleted", async () => {
    const softDelete = await fixtures.admin
      .from("organizations")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", orgA.id);
    expect(softDelete.error).toBeNull();

    const result = await ownerClient
      .from("organizations")
      .select("*")
      .eq("id", orgA.id);
    expect(result.error).toBeNull();
    expect(result.data).toEqual([]);
  });
});
