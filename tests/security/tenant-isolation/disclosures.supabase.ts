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
 * RLS on `public.disclosures` (TASK-016), through the Data API as real
 * signed-in users: user A cannot read, publish into or enumerate
 * organization B's disclosures, or publish under B's system. Publishing is
 * for members and up; a viewer reads only. No signed-in user updates or
 * deletes a published version — the table grants neither privilege at all,
 * whatever the row or the organization — and a user's choice of id, version,
 * created_by or created_at is never honored. Routes arrive in TASK-017 and
 * TASK-018 and must repeat these checks at the HTTP layer.
 */

const fixtures = createTenantFixtures();

let ownerA: TestUser;
let clientA: SupabaseClient;
let orgA: TestOrganization;
let systemA: string;

let clientB: SupabaseClient;
let orgB: TestOrganization;
let systemB: string;
let disclosureB: string;

let viewerClient: SupabaseClient;
let memberClient: SupabaseClient;

let deletedOrg: TestOrganization;
let systemOfDeletedOrg: string;
let disclosureOfDeletedOrg: string;

function uniqueMessage(label: string) {
  return `${label} ${randomUUID().slice(0, 8)}.`;
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
    .from("disclosures")
    .insert({ message: uniqueMessage("Notice"), language: "en", ...row })
    .select("id")
    .maybeSingle();
}

async function publish(
  client: SupabaseClient,
  organizationId: string,
  aiSystemId: string,
): Promise<string> {
  const { data, error } = await insertAs(client, {
    organization_id: organizationId,
    ai_system_id: aiSystemId,
  });
  if (error || !data) {
    throw error ?? new Error("no disclosure published");
  }
  return data.id as string;
}

async function disclosureRow(id: string) {
  const { data } = await fixtures.admin
    .from("disclosures")
    .select("*")
    .eq("id", id)
    .single();
  return data as Record<string, unknown>;
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
  disclosureB = await publish(clientB, orgB.id, systemB);

  const viewerOfA = await fixtures.createUser();
  await fixtures.addMember(orgA.id, viewerOfA.id, "viewer");
  viewerClient = await fixtures.signedInClient(viewerOfA);

  const memberOfA = await fixtures.createUser();
  await fixtures.addMember(orgA.id, memberOfA.id, "member");
  memberClient = await fixtures.signedInClient(memberOfA);

  deletedOrg = await fixtures.createOrganization({ ownerId: ownerA.id });
  systemOfDeletedOrg = await createSystem(clientA, deletedOrg.id);
  disclosureOfDeletedOrg = await publish(
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

describe("user A cannot reach organization B's disclosures", () => {
  it("cannot read B's disclosure by id", async () => {
    const { data, error } = await clientA
      .from("disclosures")
      .select("id")
      .eq("id", disclosureB);

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("cannot enumerate B's disclosures: an unfiltered list holds A's only", async () => {
    await publish(clientA, orgA.id, systemA);

    const { data } = await clientA
      .from("disclosures")
      .select("organization_id");

    expect(data?.length).toBeGreaterThan(0);
    expect(
      new Set(data?.map(({ organization_id }) => organization_id as string)),
    ).toEqual(new Set([orgA.id]));
  });

  it("cannot publish into B: B's system is refused as if it didn't exist", async () => {
    const { error } = await insertAs(clientA, {
      organization_id: orgB.id,
      ai_system_id: systemB,
    });

    expect(error?.code).toBe("23503");
  });

  it("cannot learn whether B's system has a disclosure: naming A's own organization with B's system is refused the same way whatever B has published, and like a system that doesn't exist", async () => {
    // systemB already has a published version; the fresh one has none.
    // Before the version trigger checked the pair, the first collided with
    // B's version 1 (23505) and the second failed the foreign key (23503).
    const freshSystemOfB = await createSystem(clientB, orgB.id);

    const withHistory = await insertAs(clientA, {
      organization_id: orgA.id,
      ai_system_id: systemB,
    });
    const withoutHistory = await insertAs(clientA, {
      organization_id: orgA.id,
      ai_system_id: freshSystemOfB,
    });
    const toNothing = await insertAs(clientA, {
      organization_id: orgA.id,
      ai_system_id: randomUUID(),
    });

    expect(withHistory.error?.code).toBe("23503");
    expect(withoutHistory.error?.code).toBe("23503");
    expect(toNothing.error?.code).toBe("23503");
  });

  it("cannot learn that B's system is archived: it is refused as if it didn't exist, before the archived-system check", async () => {
    const archivedOfB = await createSystem(clientB, orgB.id);
    await clientB
      .from("ai_systems")
      .update({ status: "archived" })
      .eq("id", archivedOfB);

    const { error } = await insertAs(clientA, {
      organization_id: orgB.id,
      ai_system_id: archivedOfB,
    });

    expect(error?.code).toBe("23503");
  });
});

describe("roles within an organization", () => {
  it("a viewer reads A's disclosures but cannot publish", async () => {
    await publish(clientA, orgA.id, systemA);
    const { data: listed } = await viewerClient
      .from("disclosures")
      .select("id");
    expect(listed?.length).toBeGreaterThan(0);

    const { error } = await insertAs(viewerClient, {
      organization_id: orgA.id,
      ai_system_id: systemA,
    });
    expect(error?.code).toBe("42501");
  });

  it("a member publishes", async () => {
    const { data, error } = await insertAs(memberClient, {
      organization_id: orgA.id,
      ai_system_id: systemA,
    });

    expect(error).toBeNull();
    expect(data?.id).toBeTruthy();
  });
});

describe("no one updates or deletes a published version", () => {
  it.each([
    ["the owner", () => clientA],
    ["a member", () => memberClient],
    ["a viewer", () => viewerClient],
  ])(
    "%s cannot update a disclosure: no rows change, and the row is untouched",
    async (_label, client) => {
      const id = await publish(clientA, orgA.id, systemA);
      const before = await disclosureRow(id);

      const { data, error } = await client()
        .from("disclosures")
        .update({ enabled: false })
        .eq("id", id)
        .select("id");

      expect(data ?? []).toEqual([]);
      if (error) {
        expect(error.code).toBeTruthy();
      }
      expect(await disclosureRow(id)).toEqual(before);
    },
  );

  it.each([
    ["the owner", () => clientA],
    ["a member", () => memberClient],
    ["a viewer", () => viewerClient],
  ])(
    "%s cannot delete a disclosure: no rows change, and the row is untouched",
    async (_label, client) => {
      const id = await publish(clientA, orgA.id, systemA);
      const before = await disclosureRow(id);

      const { data, error } = await client()
        .from("disclosures")
        .delete()
        .eq("id", id)
        .select("id");

      expect(data ?? []).toEqual([]);
      if (error) {
        expect(error.code).toBeTruthy();
      }
      expect(await disclosureRow(id)).toEqual(before);
    },
  );
});

describe("what a user cannot set", () => {
  it.each([
    ["id", () => randomUUID()],
    ["version", () => 999],
    ["created_by", () => randomUUID()],
    ["created_at", () => "2000-01-01T00:00:00Z"],
  ])("cannot choose %s on publish", async (column, value) => {
    const { error } = await insertAs(clientA, {
      organization_id: orgA.id,
      ai_system_id: systemA,
      [column]: value(),
    });

    expect(error?.code).toBe("42501");
  });
});

describe("soft-deleted organizations and anonymous callers", () => {
  it("a soft-deleted organization's disclosures are not readable, even by its owner", async () => {
    const { data } = await clientA
      .from("disclosures")
      .select("id")
      .eq("id", disclosureOfDeletedOrg);

    expect(data).toEqual([]);
  });

  it("nor publishable into, even under its own system: that system is hidden with it, so it is refused as if it didn't exist", async () => {
    const { error } = await insertAs(clientA, {
      organization_id: deletedOrg.id,
      ai_system_id: systemOfDeletedOrg,
    });

    expect(error?.code).toBe("23503");
  });

  it("the anon key reads and writes nothing", async () => {
    const anon = anonClient();

    const read = await anon
      .from("disclosures")
      .select("id")
      .eq("id", disclosureB);
    const write = await insertAs(anon, {
      organization_id: orgB.id,
      ai_system_id: systemB,
    });

    expect(read.data ?? []).toEqual([]);
    expect(write.error).not.toBeNull();
  });
});
