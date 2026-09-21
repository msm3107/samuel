import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * README §8's isolation checks through the organization API routes, against
 * the real local database (TASK-007). organizations.supabase.ts proves the
 * same boundary in RLS alone; this file proves the application code on top
 * of it does not open a way around it.
 *
 * The session layer is routed to real signed-in clients (acting-user.ts), so
 * every query runs under the acting user's JWT.
 */
vi.mock(
  "@/lib/auth/require-session",
  async () =>
    (await import("@/tests/security/tenant-isolation/support/acting-user"))
      .requireSessionModule,
);
vi.mock(
  "@/lib/database/session-client",
  async () =>
    (await import("@/tests/security/tenant-isolation/support/acting-user"))
      .sessionClientModule,
);

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  GET as getOrganization,
  PATCH as patchOrganization,
} from "@/app/api/organizations/[organizationId]/route";
import {
  GET as listOrganizations,
  POST as createOrganization,
} from "@/app/api/organizations/route";
import { AuthorizationError } from "@/lib/auth/errors";
import { requireOrganizationPermission } from "@/lib/auth/require-organization-role";
import {
  actAs,
  actAsNobody,
} from "@/tests/security/tenant-isolation/support/acting-user";
import {
  apiRequest,
  readError,
  routeContext,
} from "@/tests/security/tenant-isolation/support/api-requests";
import {
  anonClient,
  createTenantFixtures,
  type TestOrganization,
  type TestUser,
} from "@/tests/security/tenant-isolation/support/tenants";

const fixtures = createTenantFixtures();

let userA: TestUser;
let clientA: SupabaseClient;
let orgA: TestOrganization;
let deletedOrgA: TestOrganization;

let userB: TestUser;
let orgB: TestOrganization;

let viewerOfA: TestUser;
let viewerClient: SupabaseClient;
let adminOfA: TestUser;
let adminClient: SupabaseClient;

beforeAll(async () => {
  userA = await fixtures.createUser();
  clientA = await fixtures.signedInClient(userA);
  orgA = await fixtures.createOrganization({ ownerId: userA.id });
  deletedOrgA = await fixtures.createOrganization({ ownerId: userA.id });
  const { error } = await fixtures.admin
    .from("organizations")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", deletedOrgA.id);
  if (error) {
    throw error;
  }

  userB = await fixtures.createUser();
  orgB = await fixtures.createOrganization({ ownerId: userB.id });

  viewerOfA = await fixtures.createUser();
  await fixtures.addMember(orgA.id, viewerOfA.id, "viewer");
  viewerClient = await fixtures.signedInClient(viewerOfA);

  adminOfA = await fixtures.createUser();
  await fixtures.addMember(orgA.id, adminOfA.id, "admin");
  adminClient = await fixtures.signedInClient(adminOfA);
}, 30_000);

afterAll(async () => {
  await fixtures.cleanup();
});

async function nameOf(organizationId: string) {
  const { data } = await fixtures.admin
    .from("organizations")
    .select("name")
    .eq("id", organizationId)
    .single();
  return data?.name as string;
}

async function organizationsNamed(name: string) {
  const { count } = await fixtures.admin
    .from("organizations")
    .select("id", { count: "exact", head: true })
    .eq("name", name);
  return count;
}

describe("user A cannot read organization B through the API", () => {
  it("is refused with the same 403 as for an organization that does not exist, was deleted, or is not an ID", async () => {
    actAs(userA, clientA);
    const probes = [orgB.id, randomUUID(), deletedOrgA.id, "not-a-uuid"];

    const codes = [];
    for (const organizationId of probes) {
      const response = await getOrganization(
        apiRequest("GET", `/api/organizations/${organizationId}`),
        routeContext(organizationId),
      );
      expect(response.status).toBe(403);
      codes.push((await readError(response)).code);
    }

    expect(new Set(codes)).toEqual(new Set(["organization_access_denied"]));
  });

  it("while a member of A reads A, and sees only id, name and slug", async () => {
    actAs(viewerOfA, viewerClient);

    const response = await getOrganization(
      apiRequest("GET", `/api/organizations/${orgA.id}`),
      routeContext(orgA.id),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      organization: { id: orgA.id, name: orgA.name, slug: orgA.slug },
    });
  });
});

describe("user A cannot enumerate organization B through the API", () => {
  it("lists A's live organizations only", async () => {
    actAs(userA, clientA);

    const response = await listOrganizations();

    expect(response.status).toBe(200);
    const { organizations } = (await response.json()) as {
      organizations: { id: string }[];
    };
    const ids = organizations.map(({ id }) => id);
    expect(ids).toContain(orgA.id);
    expect(ids).not.toContain(orgB.id);
    expect(ids).not.toContain(deletedOrgA.id);
  });

  it("lists nothing for a user in no organization", async () => {
    const loner = await fixtures.createUser();
    actAs(loner, await fixtures.signedInClient(loner));

    const response = await listOrganizations();

    expect(await response.json()).toEqual({ organizations: [] });
  });
});

describe("user A cannot update or act for organization B through the API", () => {
  it("cannot rename B, and B's name is unchanged", async () => {
    actAs(userA, clientA);
    const before = await nameOf(orgB.id);

    const response = await patchOrganization(
      apiRequest("PATCH", `/api/organizations/${orgB.id}`, {
        body: { name: "Taken over" },
      }),
      routeContext(orgB.id),
    );

    expect(response.status).toBe(403);
    expect((await readError(response)).code).toBe("organization_access_denied");
    expect(await nameOf(orgB.id)).toBe(before);
  });

  it("is refused before the body is read, so an invalid body reveals nothing either", async () => {
    actAs(userA, clientA);

    const response = await patchOrganization(
      apiRequest("PATCH", `/api/organizations/${orgB.id}`, {
        rawBody: "{not json",
      }),
      routeContext(orgB.id),
    );

    expect(response.status).toBe(403);
    expect((await readError(response)).code).toBe("organization_access_denied");
  });

  it("cannot generate reports for B", async () => {
    actAs(userA, clientA);

    await expect(
      requireOrganizationPermission({
        organizationId: orgB.id,
        permission: "reports.generate",
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("an owner and an admin of A may rename A; a viewer may not", async () => {
    actAs(userA, clientA);
    const byOwner = await patchOrganization(
      apiRequest("PATCH", `/api/organizations/${orgA.id}`, {
        body: { name: "Renamed by owner" },
      }),
      routeContext(orgA.id),
    );
    expect(byOwner.status).toBe(200);
    expect(await byOwner.json()).toEqual({
      organization: { id: orgA.id, name: "Renamed by owner", slug: orgA.slug },
    });

    actAs(adminOfA, adminClient);
    const byAdmin = await patchOrganization(
      apiRequest("PATCH", `/api/organizations/${orgA.id}`, {
        body: { name: "Renamed by admin" },
      }),
      routeContext(orgA.id),
    );
    expect(byAdmin.status).toBe(200);

    actAs(viewerOfA, viewerClient);
    const byViewer = await patchOrganization(
      apiRequest("PATCH", `/api/organizations/${orgA.id}`, {
        body: { name: "Renamed by viewer" },
      }),
      routeContext(orgA.id),
    );
    expect(byViewer.status).toBe(403);
    expect(await nameOf(orgA.id)).toBe("Renamed by admin");
  });

  it("cannot change the slug through a rename", async () => {
    actAs(userA, clientA);

    const response = await patchOrganization(
      apiRequest("PATCH", `/api/organizations/${orgA.id}`, {
        body: { name: "Still A", slug: "stolen-slug" },
      }),
      routeContext(orgA.id),
    );

    expect(response.status).toBe(400);
    expect((await readError(response)).code).toBe("invalid_request");
  });
});

describe("creation takes nothing but a name from the request", () => {
  it.each([
    ["userId", () => userB.id],
    ["user_id", () => userB.id],
    ["role", () => "owner"],
    ["organizationId", () => orgB.id],
    ["slug", () => "chosen-slug"],
  ])(
    "refuses a body that also carries %s, and creates nothing",
    async (field, value) => {
      actAs(userA, clientA);
      const name = `Smuggled ${randomUUID().slice(0, 8)}`;

      const response = await createOrganization(
        apiRequest("POST", "/api/organizations", {
          body: { name, [field]: value() },
        }),
      );

      expect(response.status).toBe(400);
      expect((await readError(response)).code).toBe("invalid_request");
      expect(await organizationsNamed(name)).toBe(0);
    },
  );

  it("refuses an unauthenticated request, and creates nothing", async () => {
    actAsNobody();
    const name = `Anonymous ${randomUUID().slice(0, 8)}`;

    const response = await createOrganization(
      apiRequest("POST", "/api/organizations", { body: { name } }),
    );

    expect(response.status).toBe(401);
    expect((await readError(response)).code).toBe("authentication_required");
    expect(await organizationsNamed(name)).toBe(0);
  });
});

describe("the database function cannot be pointed at another user", () => {
  it("has no parameter for an owner: naming one does not resolve", async () => {
    const name = `Direct ${randomUUID().slice(0, 8)}`;

    const { error } = await clientA.rpc("create_organization", {
      p_name: name,
      p_user_id: userB.id,
    });

    expect(error?.code).toBe("PGRST202");
    expect(await organizationsNamed(name)).toBe(0);
  });

  it("refuses the anon key", async () => {
    const name = `Anon ${randomUUID().slice(0, 8)}`;

    const { error } = await anonClient().rpc("create_organization", {
      p_name: name,
    });

    expect(error).not.toBeNull();
    expect(await organizationsNamed(name)).toBe(0);
  });

  it("makes the caller the owner when called directly, never anyone else", async () => {
    const { data, error } = await clientA.rpc("create_organization", {
      p_name: `Direct ${randomUUID().slice(0, 8)}`,
    });
    expect(error).toBeNull();

    const { data: memberships } = await fixtures.admin
      .from("memberships")
      .select("user_id, role")
      .eq("organization_id", (data as { id: string }).id);
    expect(memberships).toEqual([{ user_id: userA.id, role: "owner" }]);
  });
});
