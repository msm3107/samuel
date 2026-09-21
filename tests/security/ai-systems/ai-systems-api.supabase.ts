import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * README §8's isolation checks for AI systems through the routes, against
 * the real local database (TASK-009). ai-systems.supabase.ts in
 * tests/security/tenant-isolation proves the same boundary in RLS alone;
 * this proves the routes on top of it add no way around it.
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
  GET as getSystem,
  PATCH as patchSystem,
} from "@/app/api/organizations/[organizationId]/ai-systems/[systemId]/route";
import {
  GET as listSystems,
  POST as createSystem,
} from "@/app/api/organizations/[organizationId]/ai-systems/route";
import { actAs } from "@/tests/security/tenant-isolation/support/acting-user";
import {
  apiRequest,
  readError,
} from "@/tests/security/tenant-isolation/support/api-requests";
import {
  createTenantFixtures,
  type TestOrganization,
  type TestUser,
} from "@/tests/security/tenant-isolation/support/tenants";

const fixtures = createTenantFixtures();

let userA: TestUser;
let clientA: SupabaseClient;
let orgA: TestOrganization;
let systemA: string;

let userB: TestUser;
let clientB: SupabaseClient;
let orgB: TestOrganization;
let systemB: string;

let viewerOfA: TestUser;
let viewerClient: SupabaseClient;

function collection(organizationId: string, query = "") {
  const path = `/api/organizations/${organizationId}/ai-systems${query}`;
  return {
    path,
    context: { params: Promise.resolve({ organizationId }) },
  };
}

function item(organizationId: string, systemId: string) {
  return {
    path: `/api/organizations/${organizationId}/ai-systems/${systemId}`,
    context: { params: Promise.resolve({ organizationId, systemId }) },
  };
}

async function createAs(organizationId: string, body: unknown) {
  const { path, context } = collection(organizationId);
  return createSystem(apiRequest("POST", path, { body }), context);
}

async function systemRow(id: string) {
  const { data } = await fixtures.admin
    .from("ai_systems")
    .select("organization_id, name, status, provider")
    .eq("id", id)
    .single();
  return data;
}

beforeAll(async () => {
  userA = await fixtures.createUser();
  clientA = await fixtures.signedInClient(userA);
  orgA = await fixtures.createOrganization({ ownerId: userA.id });

  userB = await fixtures.createUser();
  clientB = await fixtures.signedInClient(userB);
  orgB = await fixtures.createOrganization({ ownerId: userB.id });

  viewerOfA = await fixtures.createUser();
  await fixtures.addMember(orgA.id, viewerOfA.id, "viewer");
  viewerClient = await fixtures.signedInClient(viewerOfA);

  actAs(userA, clientA);
  const a = await createAs(orgA.id, { name: "A's Bot", systemType: "chatbot" });
  systemA = ((await a.json()) as { aiSystem: { id: string } }).aiSystem.id;

  actAs(userB, clientB);
  const b = await createAs(orgB.id, { name: "B's Bot", systemType: "chatbot" });
  systemB = ((await b.json()) as { aiSystem: { id: string } }).aiSystem.id;
}, 30_000);

afterAll(async () => {
  await fixtures.cleanup();
});

describe("user A and organization B's systems", () => {
  it("cannot list B's systems: 403, the same as for any organization A is not in", async () => {
    actAs(userA, clientA);

    for (const organizationId of [orgB.id, randomUUID()]) {
      const { path, context } = collection(organizationId, "?status=all");
      const response = await listSystems(apiRequest("GET", path), context);
      expect(response.status).toBe(403);
      expect((await readError(response)).code).toBe(
        "organization_access_denied",
      );
    }
  });

  it("cannot read B's system under B's organization", async () => {
    actAs(userA, clientA);
    const { path, context } = item(orgB.id, systemB);

    const response = await getSystem(apiRequest("GET", path), context);

    expect(response.status).toBe(403);
  });

  it("gets a 404 for B's system under A's own organization, the same as a system that does not exist", async () => {
    actAs(userA, clientA);

    for (const systemId of [systemB, randomUUID(), "not-a-uuid"]) {
      const { path, context } = item(orgA.id, systemId);
      const response = await getSystem(apiRequest("GET", path), context);
      expect(response.status).toBe(404);
      expect((await readError(response)).code).toBe("ai_system_not_found");
    }
  });

  it("cannot create a system in B", async () => {
    actAs(userA, clientA);
    const name = `Planted ${randomUUID().slice(0, 8)}`;

    const response = await createAs(orgB.id, { name, systemType: "chatbot" });

    expect(response.status).toBe(403);
    const { count } = await fixtures.admin
      .from("ai_systems")
      .select("id", { count: "exact", head: true })
      .eq("name", name);
    expect(count).toBe(0);
  });

  it("cannot edit or archive B's system, under either organization's URL", async () => {
    actAs(userA, clientA);
    const before = await systemRow(systemB);

    const underB = item(orgB.id, systemB);
    const viaB = await patchSystem(
      apiRequest("PATCH", underB.path, { body: { status: "archived" } }),
      underB.context,
    );
    const underA = item(orgA.id, systemB);
    const viaA = await patchSystem(
      apiRequest("PATCH", underA.path, { body: { name: "Taken over" } }),
      underA.context,
    );

    expect(viaB.status).toBe(403);
    expect(viaA.status).toBe(404);
    expect(await systemRow(systemB)).toEqual(before);
  });

  it("lists only A's systems under A", async () => {
    actAs(userA, clientA);
    const { path, context } = collection(orgA.id, "?status=all");

    const response = await listSystems(apiRequest("GET", path), context);

    const { aiSystems } = (await response.json()) as {
      aiSystems: { id: string }[];
    };
    const ids = aiSystems.map(({ id }) => id);
    expect(ids).toContain(systemA);
    expect(ids).not.toContain(systemB);
  });
});

describe("roles", () => {
  it("a viewer lists and reads A's systems", async () => {
    actAs(viewerOfA, viewerClient);

    const list = collection(orgA.id);
    const listed = await listSystems(
      apiRequest("GET", list.path),
      list.context,
    );
    const one = item(orgA.id, systemA);
    const read = await getSystem(apiRequest("GET", one.path), one.context);

    expect(listed.status).toBe(200);
    expect(read.status).toBe(200);
  });

  it("a viewer cannot create, edit or archive: 403 before the body is read", async () => {
    actAs(viewerOfA, viewerClient);
    const before = await systemRow(systemA);

    const created = await createAs(orgA.id, { not: "even valid" });
    const one = item(orgA.id, systemA);
    const edited = await patchSystem(
      apiRequest("PATCH", one.path, { body: { status: "archived" } }),
      one.context,
    );

    expect(created.status).toBe(403);
    expect(edited.status).toBe(403);
    expect(await systemRow(systemA)).toEqual(before);
  });
});

describe("what a request cannot choose", () => {
  it.each([
    ["organizationId", () => orgB.id],
    ["organization_id", () => orgB.id],
    ["id", () => randomUUID()],
    ["status", () => "archived"],
  ])(
    "a creation carrying %s is refused, and nothing is created",
    async (field, value) => {
      actAs(userA, clientA);
      const name = `Smuggled ${randomUUID().slice(0, 8)}`;

      const response = await createAs(orgA.id, {
        name,
        systemType: "chatbot",
        [field]: value(),
      });

      expect(response.status).toBe(400);
      const { count } = await fixtures.admin
        .from("ai_systems")
        .select("id", { count: "exact", head: true })
        .eq("name", name);
      expect(count).toBe(0);
    },
  );

  it("an edit carrying organizationId is refused, and the system stays put", async () => {
    actAs(userA, clientA);
    const one = item(orgA.id, systemA);

    const response = await patchSystem(
      apiRequest("PATCH", one.path, {
        body: { name: "Moved", organizationId: orgB.id },
      }),
      one.context,
    );

    expect(response.status).toBe(400);
    expect((await systemRow(systemA))?.organization_id).toBe(orgA.id);
  });
});
