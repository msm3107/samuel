import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The "current actor": whoever `requireSession` and `createResolvingSessionClient`
 * answer with next, set per test with `actAs`. Routing the mocked session
 * layer to a real, signed-in Supabase client means the membership read this
 * suite exercises runs under real RLS (TASK-005's amendment), not a stand-in.
 */
const actor = vi.hoisted(() => ({
  userId: null as string | null,
  supabase: null as unknown,
}));

vi.mock("@/lib/auth/require-session", () => ({
  requireSession: async () => {
    if (actor.userId === null) {
      throw new Error("test harness: actor was never set with actAs()");
    }
    return { userId: actor.userId };
  },
}));

vi.mock("@/lib/database/session-client", () => ({
  createResolvingSessionClient: async () => {
    if (actor.supabase === null) {
      throw new Error("test harness: actor was never set with actAs()");
    }
    return { supabase: actor.supabase, applyHeldRemovals: () => {} };
  },
}));

import type { SupabaseClient } from "@supabase/supabase-js";

import { AuthorizationError } from "@/lib/auth/errors";
import {
  requireMemberManagement,
  requireOrganizationRole,
} from "@/lib/auth/require-organization-role";
import {
  createTenantFixtures,
  type TestOrganization,
  type TestUser,
} from "@/tests/security/tenant-isolation/support/tenants";

const fixtures = createTenantFixtures();

async function actAs(user: TestUser, client: SupabaseClient): Promise<void> {
  actor.userId = user.id;
  actor.supabase = client;
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

let userA: TestUser;
let orgA: TestOrganization;
let ownerClient: SupabaseClient;

let userB: TestUser;
let orgB: TestOrganization;

let viewerUser: TestUser;
let viewerClient: SupabaseClient;

let memberUser: TestUser;
let memberClient: SupabaseClient;

let adminUser: TestUser;
let adminClient: SupabaseClient;

let anotherOwnerUser: TestUser;

beforeAll(async () => {
  userA = await fixtures.createUser();
  orgA = await fixtures.createOrganization({ ownerId: userA.id });
  ownerClient = await fixtures.signedInClient(userA);

  userB = await fixtures.createUser();
  orgB = await fixtures.createOrganization({ ownerId: userB.id });

  viewerUser = await fixtures.createUser();
  await fixtures.addMember(orgA.id, viewerUser.id, "viewer");
  viewerClient = await fixtures.signedInClient(viewerUser);

  memberUser = await fixtures.createUser();
  await fixtures.addMember(orgA.id, memberUser.id, "member");
  memberClient = await fixtures.signedInClient(memberUser);

  adminUser = await fixtures.createUser();
  await fixtures.addMember(orgA.id, adminUser.id, "admin");
  adminClient = await fixtures.signedInClient(adminUser);

  anotherOwnerUser = await fixtures.createUser();
  await fixtures.addMember(orgA.id, anotherOwnerUser.id, "owner");
}, 30_000);

afterAll(async () => {
  await fixtures.cleanup();
});

describe("requireOrganizationRole against real RLS", () => {
  it("rejects a user who owns a different organization but is not a member of the target", async () => {
    await actAs(userA, ownerClient);

    const error = await captureRejection(
      requireOrganizationRole({
        organizationId: orgB.id,
        minimumRole: "viewer",
      }),
    );

    expect(error).toBeInstanceOf(AuthorizationError);
  });

  it.each(["member", "admin", "owner"] as const)(
    "rejects a viewer against minimumRole %s",
    async (minimumRole) => {
      await actAs(viewerUser, viewerClient);

      const error = await captureRejection(
        requireOrganizationRole({ organizationId: orgA.id, minimumRole }),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
    },
  );

  it("passes a viewer at minimumRole viewer", async () => {
    await actAs(viewerUser, viewerClient);

    await expect(
      requireOrganizationRole({
        organizationId: orgA.id,
        minimumRole: "viewer",
      }),
    ).resolves.toMatchObject({ role: "viewer", userId: viewerUser.id });
  });

  it("passes a member at minimumRole member and rejects at minimumRole admin", async () => {
    await actAs(memberUser, memberClient);

    await expect(
      requireOrganizationRole({
        organizationId: orgA.id,
        minimumRole: "member",
      }),
    ).resolves.toMatchObject({ role: "member" });

    const error = await captureRejection(
      requireOrganizationRole({
        organizationId: orgA.id,
        minimumRole: "admin",
      }),
    );
    expect(error).toBeInstanceOf(AuthorizationError);
  });

  it("passes an admin at minimumRole admin and rejects at minimumRole owner", async () => {
    await actAs(adminUser, adminClient);

    await expect(
      requireOrganizationRole({
        organizationId: orgA.id,
        minimumRole: "admin",
      }),
    ).resolves.toMatchObject({ role: "admin" });

    const error = await captureRejection(
      requireOrganizationRole({
        organizationId: orgA.id,
        minimumRole: "owner",
      }),
    );
    expect(error).toBeInstanceOf(AuthorizationError);
  });

  it("passes an owner at minimumRole owner", async () => {
    await actAs(userA, ownerClient);

    await expect(
      requireOrganizationRole({
        organizationId: orgA.id,
        minimumRole: "owner",
      }),
    ).resolves.toMatchObject({ role: "owner" });
  });

  it("rejects a nonexistent organization the same way as one the user is not a member of", async () => {
    await actAs(userA, ownerClient);

    const nonexistent = await captureRejection(
      requireOrganizationRole({
        organizationId: randomUUID(),
        minimumRole: "viewer",
      }),
    );
    const notAMember = await captureRejection(
      requireOrganizationRole({
        organizationId: orgB.id,
        minimumRole: "viewer",
      }),
    );

    expect(nonexistent).toBeInstanceOf(AuthorizationError);
    expect(notAMember).toBeInstanceOf(AuthorizationError);
    const [first, second] = [nonexistent, notAMember] as [
      AuthorizationError,
      AuthorizationError,
    ];
    expect(second.constructor).toBe(first.constructor);
    expect(second.message).toBe(first.message);
    expect(second.code).toBe(first.code);
  });

  it("rejects a revoked membership on the very next call", async () => {
    const user = await fixtures.createUser();
    const membership = await fixtures.addMember(orgA.id, user.id, "member");
    const client = await fixtures.signedInClient(user);
    await actAs(user, client);

    await expect(
      requireOrganizationRole({
        organizationId: orgA.id,
        minimumRole: "member",
      }),
    ).resolves.toMatchObject({ role: "member" });

    const deletion = await fixtures.admin
      .from("memberships")
      .delete()
      .eq("id", membership.id);
    expect(deletion.error).toBeNull();

    const error = await captureRejection(
      requireOrganizationRole({
        organizationId: orgA.id,
        minimumRole: "member",
      }),
    );
    expect(error).toBeInstanceOf(AuthorizationError);
  });

  it("rejects the owner of a since soft-deleted organization", async () => {
    const user = await fixtures.createUser();
    const org = await fixtures.createOrganization({ ownerId: user.id });
    const client = await fixtures.signedInClient(user);
    await actAs(user, client);

    await expect(
      requireOrganizationRole({
        organizationId: org.id,
        minimumRole: "viewer",
      }),
    ).resolves.toMatchObject({ role: "owner" });

    const softDelete = await fixtures.admin
      .from("organizations")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", org.id);
    expect(softDelete.error).toBeNull();

    const error = await captureRejection(
      requireOrganizationRole({
        organizationId: org.id,
        minimumRole: "viewer",
      }),
    );
    expect(error).toBeInstanceOf(AuthorizationError);
  });
});

describe("requireMemberManagement against real RLS", () => {
  it("rejects an admin acting on an owner target", async () => {
    await actAs(adminUser, adminClient);

    const error = await captureRejection(
      requireMemberManagement({
        organizationId: orgA.id,
        targetUserId: userA.id,
      }),
    );

    expect(error).toBeInstanceOf(AuthorizationError);
  });

  it("lets an admin act on a member target and reads the role from the database", async () => {
    await actAs(adminUser, adminClient);

    const access = await requireMemberManagement({
      organizationId: orgA.id,
      targetUserId: memberUser.id,
    });

    expect(access.target).toEqual({ userId: memberUser.id, role: "member" });
  });

  it("rejects an admin assigning the owner role", async () => {
    await actAs(adminUser, adminClient);

    const error = await captureRejection(
      requireMemberManagement({
        organizationId: orgA.id,
        targetUserId: memberUser.id,
        assignsRole: "owner",
      }),
    );

    expect(error).toBeInstanceOf(AuthorizationError);
  });

  it("lets an owner act on another owner", async () => {
    await actAs(userA, ownerClient);

    const access = await requireMemberManagement({
      organizationId: orgA.id,
      targetUserId: anotherOwnerUser.id,
    });

    expect(access.target).toEqual({
      userId: anotherOwnerUser.id,
      role: "owner",
    });
  });
});
