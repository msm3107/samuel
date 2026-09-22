import { randomUUID } from "node:crypto";

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
 * RLS on `public.deployments` (TASK-011), through the Data API as real
 * signed-in users: user A cannot read, write or enumerate organization B's
 * deployments, or attach a deployment to B's system. Routes arrive in
 * TASK-013 and must repeat these checks at the HTTP layer.
 */

const fixtures = createTenantFixtures();

let ownerA: TestUser;
let clientA: SupabaseClient;
let orgA: TestOrganization;
let systemA: string;

let clientB: SupabaseClient;
let orgB: TestOrganization;
let systemB: string;
let deploymentB: string;

let viewerClient: SupabaseClient;
let memberClient: SupabaseClient;

let deletedOrg: TestOrganization;
let deploymentOfDeletedOrg: string;

function uniqueHostname(label: string) {
  return `${label}-${randomUUID().slice(0, 8)}.example.com`;
}

async function createSystem(
  client: SupabaseClient,
  organizationId: string,
): Promise<string> {
  const { data, error } = await client
    .from("ai_systems")
    .insert({
      organization_id: organizationId,
      name: `System ${randomUUID().slice(0, 8)}`,
      system_type: "chatbot",
    })
    .select("id")
    .single();
  if (error) {
    throw error;
  }
  return data.id as string;
}

async function insertAs(client: SupabaseClient, row: Record<string, unknown>) {
  return client
    .from("deployments")
    .insert({ hostname: uniqueHostname("site"), ...row })
    .select("id")
    .maybeSingle();
}

async function createDeployment(
  client: SupabaseClient,
  organizationId: string,
  aiSystemId: string,
): Promise<string> {
  const { data, error } = await insertAs(client, {
    organization_id: organizationId,
    ai_system_id: aiSystemId,
  });
  if (error || !data) {
    throw error ?? new Error("no deployment created");
  }
  return data.id as string;
}

async function deploymentRow(id: string) {
  const { data } = await fixtures.admin
    .from("deployments")
    .select("*")
    .eq("id", id)
    .single();
  return data as Record<string, unknown>;
}

async function countByHostname(hostname: string) {
  const { count } = await fixtures.admin
    .from("deployments")
    .select("id", { count: "exact", head: true })
    .eq("hostname", hostname);
  return count;
}

beforeAll(async () => {
  ownerA = await fixtures.createUser();
  clientA = await fixtures.signedInClient(ownerA);
  orgA = await fixtures.createOrganization({ ownerId: ownerA.id });
  systemA = await createSystem(clientA, orgA.id);

  const ownerB = await fixtures.createUser();
  clientB = await fixtures.signedInClient(ownerB);
  orgB = await fixtures.createOrganization({ ownerId: ownerB.id });
  systemB = await createSystem(clientB, orgB.id);
  deploymentB = await createDeployment(clientB, orgB.id, systemB);

  const viewerOfA = await fixtures.createUser();
  await fixtures.addMember(orgA.id, viewerOfA.id, "viewer");
  viewerClient = await fixtures.signedInClient(viewerOfA);

  const memberOfA = await fixtures.createUser();
  await fixtures.addMember(orgA.id, memberOfA.id, "member");
  memberClient = await fixtures.signedInClient(memberOfA);

  deletedOrg = await fixtures.createOrganization({ ownerId: ownerA.id });
  const systemOfDeletedOrg = await createSystem(clientA, deletedOrg.id);
  deploymentOfDeletedOrg = await createDeployment(
    clientA,
    deletedOrg.id,
    systemOfDeletedOrg,
  );
  const { error } = await fixtures.admin
    .from("organizations")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", deletedOrg.id);
  if (error) {
    throw error;
  }
}, 30_000);

afterAll(async () => {
  await fixtures.cleanup();
});

describe("user A cannot reach organization B's deployments", () => {
  it("cannot read B's deployment by id", async () => {
    const { data, error } = await clientA
      .from("deployments")
      .select("id")
      .eq("id", deploymentB);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("cannot enumerate B's deployments: an unfiltered list holds A's only", async () => {
    await createDeployment(clientA, orgA.id, systemA);

    const { data } = await clientA
      .from("deployments")
      .select("organization_id");

    expect(data?.length).toBeGreaterThan(0);
    expect(
      new Set(data?.map(({ organization_id }) => organization_id as string)),
    ).toEqual(new Set([orgA.id]));
  });

  it("cannot learn B's hostnames by filtering on one", async () => {
    const { hostname } = await deploymentRow(deploymentB);

    const { data } = await clientA
      .from("deployments")
      .select("id")
      .eq("hostname", hostname as string);

    expect(data).toEqual([]);
  });

  it("cannot create a deployment in B", async () => {
    const hostname = uniqueHostname("planted");

    const { error } = await insertAs(clientA, {
      organization_id: orgB.id,
      ai_system_id: systemB,
      hostname,
    });

    expect(error?.code).toBe("42501");
    expect(await countByHostname(hostname)).toBe(0);
  });

  it("cannot attach a deployment in A to B's system, and the refusal is the same as for a system that doesn't exist", async () => {
    const toB = await insertAs(clientA, {
      organization_id: orgA.id,
      ai_system_id: systemB,
    });
    const toNothing = await insertAs(clientA, {
      organization_id: orgA.id,
      ai_system_id: randomUUID(),
    });

    expect(toB.error?.code).toBe("23503");
    expect(toNothing.error?.code).toBe("23503");
  });

  it("cannot learn that B's system is archived: RLS refuses before the archived-system check", async () => {
    const archivedOfB = await createSystem(clientB, orgB.id);
    await clientB
      .from("ai_systems")
      .update({ status: "archived" })
      .eq("id", archivedOfB);

    const { error } = await insertAs(clientA, {
      organization_id: orgB.id,
      ai_system_id: archivedOfB,
    });

    expect(error?.code).toBe("42501");
  });

  it("cannot archive B's deployment", async () => {
    const before = await deploymentRow(deploymentB);

    const { data } = await clientA
      .from("deployments")
      .update({ status: "archived" })
      .eq("id", deploymentB)
      .select("id");

    expect(data).toEqual([]);
    expect(await deploymentRow(deploymentB)).toEqual(before);
  });

  it("cannot move its own deployment into B", async () => {
    const own = await createDeployment(clientA, orgA.id, systemA);

    const { error } = await clientA
      .from("deployments")
      .update({ organization_id: orgB.id, ai_system_id: systemB })
      .eq("id", own);

    expect(error?.code).toBe("42501");
    expect(await deploymentRow(own)).toMatchObject({
      organization_id: orgA.id,
      ai_system_id: systemA,
    });
  });
});

describe("roles within an organization", () => {
  it("a viewer reads A's deployments but cannot create one", async () => {
    await createDeployment(clientA, orgA.id, systemA);
    const { data: listed } = await viewerClient
      .from("deployments")
      .select("id");
    expect(listed?.length).toBeGreaterThan(0);

    const { error } = await insertAs(viewerClient, {
      organization_id: orgA.id,
      ai_system_id: systemA,
    });
    expect(error?.code).toBe("42501");
  });

  it("a viewer cannot archive one", async () => {
    const own = await createDeployment(clientA, orgA.id, systemA);
    const before = await deploymentRow(own);

    const { data } = await viewerClient
      .from("deployments")
      .update({ status: "archived" })
      .eq("id", own)
      .select("id");

    expect(data).toEqual([]);
    expect(await deploymentRow(own)).toEqual(before);
  });

  it("a member registers, archives and restores", async () => {
    const created = await createDeployment(memberClient, orgA.id, systemA);

    const archived = await memberClient
      .from("deployments")
      .update({ status: "archived" })
      .eq("id", created)
      .select("status")
      .single();
    const restored = await memberClient
      .from("deployments")
      .update({ status: "active" })
      .eq("id", created)
      .select("status")
      .single();

    expect(archived.data).toEqual({ status: "archived" });
    expect(restored.data).toEqual({ status: "active" });
  });

  it.each([
    ["the owner", () => clientA],
    ["a member", () => memberClient],
    ["a viewer", () => viewerClient],
  ])("%s cannot delete a deployment", async (_label, client) => {
    const own = await createDeployment(clientA, orgA.id, systemA);

    const { error } = await client().from("deployments").delete().eq("id", own);

    expect(error?.code).toBe("42501");
    expect(await deploymentRow(own)).toBeTruthy();
  });
});

describe("what a user cannot set", () => {
  it.each([
    ["id", () => randomUUID()],
    ["created_at", () => "2000-01-01T00:00:00Z"],
    ["updated_at", () => "2000-01-01T00:00:00Z"],
    ["status", () => "archived"],
  ])("cannot choose %s on insert", async (column, value) => {
    const { error } = await insertAs(clientA, {
      organization_id: orgA.id,
      ai_system_id: systemA,
      [column]: value(),
    });

    expect(error?.code).toBe("42501");
  });

  it.each([
    ["hostname", () => uniqueHostname("moved")],
    ["ai_system_id", () => randomUUID()],
    ["id", () => randomUUID()],
    ["created_at", () => "2000-01-01T00:00:00Z"],
  ])("cannot change %s on update", async (column, value) => {
    const own = await createDeployment(clientA, orgA.id, systemA);
    const before = await deploymentRow(own);

    const { error } = await clientA
      .from("deployments")
      .update({ [column]: value() })
      .eq("id", own);

    expect(error?.code).toBe("42501");
    expect(await deploymentRow(own)).toEqual(before);
  });
});

describe("soft-deleted organizations and anonymous callers", () => {
  it("a soft-deleted organization's deployments are not readable, even by its owner", async () => {
    const { data } = await clientA
      .from("deployments")
      .select("id")
      .eq("id", deploymentOfDeletedOrg);

    expect(data).toEqual([]);
  });

  it("nor archivable", async () => {
    const before = await deploymentRow(deploymentOfDeletedOrg);

    const { data } = await clientA
      .from("deployments")
      .update({ status: "archived" })
      .eq("id", deploymentOfDeletedOrg)
      .select("id");

    expect(data).toEqual([]);
    expect(await deploymentRow(deploymentOfDeletedOrg)).toEqual(before);
  });

  it("the anon key reads and writes nothing", async () => {
    const anon = anonClient();

    const read = await anon
      .from("deployments")
      .select("id")
      .eq("id", deploymentB);
    const write = await insertAs(anon, {
      organization_id: orgB.id,
      ai_system_id: systemB,
    });

    expect(read.data ?? []).toEqual([]);
    expect(write.error).not.toBeNull();
  });
});
