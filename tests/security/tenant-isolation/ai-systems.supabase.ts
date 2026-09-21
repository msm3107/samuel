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
 * RLS on `public.ai_systems` (TASK-008), through the Data API as real
 * signed-in users. README §8's checks for this table: user A cannot read,
 * write or enumerate organization B's systems. Routes arrive in TASK-009 and
 * must repeat these checks at the HTTP layer.
 */

const fixtures = createTenantFixtures();

let ownerA: TestUser;
let clientA: SupabaseClient;
let orgA: TestOrganization;

let ownerB: TestUser;
let clientB: SupabaseClient;
let orgB: TestOrganization;
let systemB: string;

let viewerOfA: TestUser;
let viewerClient: SupabaseClient;
let memberOfA: TestUser;
let memberClient: SupabaseClient;

let deletedOrg: TestOrganization;
let systemOfDeletedOrg: string;

function uniqueName(label: string) {
  return `${label} ${randomUUID().slice(0, 8)}`;
}

async function insertAs(client: SupabaseClient, row: Record<string, unknown>) {
  return client
    .from("ai_systems")
    .insert({ system_type: "chatbot", name: uniqueName("System"), ...row })
    .select("id")
    .maybeSingle();
}

async function systemRow(id: string) {
  const { data } = await fixtures.admin
    .from("ai_systems")
    .select("*")
    .eq("id", id)
    .single();
  return data as Record<string, unknown>;
}

beforeAll(async () => {
  ownerA = await fixtures.createUser();
  clientA = await fixtures.signedInClient(ownerA);
  orgA = await fixtures.createOrganization({ ownerId: ownerA.id });

  ownerB = await fixtures.createUser();
  clientB = await fixtures.signedInClient(ownerB);
  orgB = await fixtures.createOrganization({ ownerId: ownerB.id });
  const created = await insertAs(clientB, {
    organization_id: orgB.id,
    name: "B's Bot",
  });
  if (created.error || !created.data) {
    throw created.error ?? new Error("no system created for B");
  }
  systemB = created.data.id as string;

  viewerOfA = await fixtures.createUser();
  await fixtures.addMember(orgA.id, viewerOfA.id, "viewer");
  viewerClient = await fixtures.signedInClient(viewerOfA);

  memberOfA = await fixtures.createUser();
  await fixtures.addMember(orgA.id, memberOfA.id, "member");
  memberClient = await fixtures.signedInClient(memberOfA);

  deletedOrg = await fixtures.createOrganization({ ownerId: ownerA.id });
  const inDeleted = await insertAs(clientA, { organization_id: deletedOrg.id });
  if (inDeleted.error || !inDeleted.data) {
    throw inDeleted.error ?? new Error("no system created in deletedOrg");
  }
  systemOfDeletedOrg = inDeleted.data.id as string;
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

describe("user A cannot reach organization B's systems", () => {
  it("cannot read B's system by id", async () => {
    const { data, error } = await clientA
      .from("ai_systems")
      .select("id")
      .eq("id", systemB);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("cannot enumerate B's systems: an unfiltered list holds A's only", async () => {
    await insertAs(clientA, { organization_id: orgA.id });

    const { data } = await clientA.from("ai_systems").select("organization_id");

    expect(data?.length).toBeGreaterThan(0);
    expect(
      new Set(data?.map(({ organization_id }) => organization_id as string)),
    ).toEqual(new Set([orgA.id]));
  });

  it("cannot create a system in B", async () => {
    const name = uniqueName("Planted");

    const { error } = await insertAs(clientA, {
      organization_id: orgB.id,
      name,
    });

    expect(error?.code).toBe("42501");
    const { count } = await fixtures.admin
      .from("ai_systems")
      .select("id", { count: "exact", head: true })
      .eq("name", name);
    expect(count).toBe(0);
  });

  it("cannot update B's system", async () => {
    const before = await systemRow(systemB);

    const { data } = await clientA
      .from("ai_systems")
      .update({ name: "Taken over", status: "archived" })
      .eq("id", systemB)
      .select("id");

    expect(data).toEqual([]);
    expect(await systemRow(systemB)).toEqual(before);
  });

  it("cannot move its own system into B", async () => {
    const { data: own } = await insertAs(clientA, { organization_id: orgA.id });

    const { error } = await clientA
      .from("ai_systems")
      .update({ organization_id: orgB.id })
      .eq("id", own?.id as string);

    expect(error?.code).toBe("42501");
    expect((await systemRow(own?.id as string)).organization_id).toBe(orgA.id);
  });
});

describe("roles within an organization", () => {
  it("a viewer reads A's systems but cannot create one", async () => {
    const { data: listed } = await viewerClient.from("ai_systems").select("id");
    expect(listed?.length).toBeGreaterThan(0);

    const { error } = await insertAs(viewerClient, {
      organization_id: orgA.id,
    });
    expect(error?.code).toBe("42501");
  });

  it("a viewer cannot update or archive one", async () => {
    const { data: own } = await insertAs(clientA, { organization_id: orgA.id });
    const before = await systemRow(own?.id as string);

    const { data } = await viewerClient
      .from("ai_systems")
      .update({ status: "archived" })
      .eq("id", own?.id as string)
      .select("id");

    expect(data).toEqual([]);
    expect(await systemRow(own?.id as string)).toEqual(before);
  });

  it("a member creates, edits and archives", async () => {
    const created = await insertAs(memberClient, { organization_id: orgA.id });
    expect(created.error).toBeNull();

    const { data, error } = await memberClient
      .from("ai_systems")
      .update({ provider: "In-house", status: "archived" })
      .eq("id", created.data?.id as string)
      .select("provider, status")
      .single();

    expect(error).toBeNull();
    expect(data).toEqual({ provider: "In-house", status: "archived" });
  });

  it.each([
    ["the owner", () => clientA],
    ["a member", () => memberClient],
    ["a viewer", () => viewerClient],
  ])("%s cannot delete a system", async (_label, client) => {
    const { data: own } = await insertAs(clientA, { organization_id: orgA.id });

    const { error } = await client()
      .from("ai_systems")
      .delete()
      .eq("id", own?.id as string);

    expect(error?.code).toBe("42501");
    expect(await systemRow(own?.id as string)).toBeTruthy();
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
      [column]: value(),
    });

    expect(error?.code).toBe("42501");
  });

  it.each([
    ["id", () => randomUUID()],
    ["created_at", () => "2000-01-01T00:00:00Z"],
  ])("cannot change %s on update", async (column, value) => {
    const { data: own } = await insertAs(clientA, { organization_id: orgA.id });

    const { error } = await clientA
      .from("ai_systems")
      .update({ [column]: value() })
      .eq("id", own?.id as string);

    expect(error?.code).toBe("42501");
  });
});

describe("soft-deleted organizations and anonymous callers", () => {
  it("a soft-deleted organization's systems are not readable, even by its owner", async () => {
    const { data } = await clientA
      .from("ai_systems")
      .select("id")
      .eq("id", systemOfDeletedOrg);

    expect(data).toEqual([]);
  });

  it("nor writable", async () => {
    const { error } = await insertAs(clientA, {
      organization_id: deletedOrg.id,
    });

    expect(error?.code).toBe("42501");
  });

  it("the anon key reads and writes nothing", async () => {
    const anon = anonClient();

    const read = await anon.from("ai_systems").select("id").eq("id", systemB);
    const write = await insertAs(anon, { organization_id: orgB.id });

    expect(read.data ?? []).toEqual([]);
    expect(write.error).not.toBeNull();
  });
});
