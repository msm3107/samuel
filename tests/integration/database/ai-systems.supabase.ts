import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  createTenantFixtures,
  type TestOrganization,
  type TestUser,
} from "@/tests/security/tenant-isolation/support/tenants";

/**
 * The life of an AI system through the Data API as a signed-in member
 * (TASK-008): create, edit, archive, reuse an archived name. What the
 * database guarantees before TASK-009's services exist.
 */

const fixtures = createTenantFixtures();

let owner: TestUser;
let client: SupabaseClient;
let organization: TestOrganization;

beforeAll(async () => {
  owner = await fixtures.createUser();
  client = await fixtures.signedInClient(owner);
  organization = await fixtures.createOrganization({ ownerId: owner.id });
}, 30_000);

afterAll(async () => {
  await fixtures.cleanup();
});

function create(row: Record<string, unknown>) {
  return client
    .from("ai_systems")
    .insert({ organization_id: organization.id, ...row })
    .select()
    .single();
}

describe("an AI system's life", () => {
  it("is created active, with the database's id and timestamps", async () => {
    const { data, error } = await create({
      name: "Support Assistant",
      system_type: "assistant",
      description: "Answers billing questions.\nEscalates to a person.",
      provider: "Anthropic",
    });

    expect(error).toBeNull();
    expect(data).toMatchObject({
      organization_id: organization.id,
      name: "Support Assistant",
      system_type: "assistant",
      provider: "Anthropic",
      status: "active",
    });
    expect(data?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(data?.created_at).toBe(data?.updated_at);
  });

  it("accepts every README system type", async () => {
    for (const systemType of [
      "chatbot",
      "voice_agent",
      "assistant",
      "generator",
      "other",
    ]) {
      const { error } = await create({
        name: `Type ${systemType} ${randomUUID().slice(0, 8)}`,
        system_type: systemType,
      });
      expect(error).toBeNull();
    }
  });

  it("refuses an unknown type and an invalid name", async () => {
    const badType = await create({ name: "Robot", system_type: "robot" });
    const badName = await create({ name: "  Padded", system_type: "other" });

    expect(badType.error?.code).toBe("23514");
    expect(badName.error?.code).toBe("23514");
  });

  it("is edited, and updated_at moves", async () => {
    const { data: created } = await create({
      name: `Editable ${randomUUID().slice(0, 8)}`,
      system_type: "chatbot",
    });

    const { data, error } = await client
      .from("ai_systems")
      .update({ description: "Now described.", provider: null })
      .eq("id", created?.id as string)
      .select()
      .single();

    expect(error).toBeNull();
    expect(data?.description).toBe("Now described.");
    expect(new Date(data?.updated_at as string).getTime()).toBeGreaterThan(
      new Date(created?.updated_at as string).getTime(),
    );
  });

  it("refuses a second active system with the same name, whatever the case, and allows it once the first is archived", async () => {
    const name = `Twin ${randomUUID().slice(0, 8)}`;
    const { data: first } = await create({ name, system_type: "chatbot" });

    const clash = await create({
      name: name.toUpperCase(),
      system_type: "chatbot",
    });
    expect(clash.error?.code).toBe("23505");

    await client
      .from("ai_systems")
      .update({ status: "archived" })
      .eq("id", first?.id as string);
    const reused = await create({ name, system_type: "chatbot" });
    expect(reused.error).toBeNull();

    // Unarchiving the first would make two active systems with one name.
    const unarchive = await client
      .from("ai_systems")
      .update({ status: "active" })
      .eq("id", first?.id as string);
    expect(unarchive.error?.code).toBe("23505");
  });

  it("resolves concurrent creations of one name deterministically: one row, the rest unique violations", async () => {
    const name = `Race ${randomUUID().slice(0, 8)}`;

    const results = await Promise.all(
      Array.from({ length: 5 }, () => create({ name, system_type: "other" })),
    );

    expect(results.filter(({ error }) => error === null)).toHaveLength(1);
    expect(
      results
        .filter(({ error }) => error !== null)
        .map(({ error }) => error?.code),
    ).toEqual(Array(4).fill("23505"));
  });
});

describe("every change is audited, however it was written (PR #22 review)", () => {
  async function eventsFor(systemId: string) {
    const { data } = await fixtures.admin
      .from("audit_events")
      .select("actor_user_id, event_type, entity_type, metadata")
      .eq("entity_id", systemId)
      .order("created_at")
      .order("event_type");
    return data ?? [];
  }

  it("a direct Data API insert, edit, archive and un-archive each leave an event naming the user", async () => {
    const { data: created } = await create({
      name: `Audited ${randomUUID().slice(0, 8)}`,
      system_type: "chatbot",
    });
    const id = created?.id as string;

    await client
      .from("ai_systems")
      .update({ system_type: "assistant", provider: "OpenAI" })
      .eq("id", id);
    await client.from("ai_systems").update({ status: "archived" }).eq("id", id);
    await client.from("ai_systems").update({ status: "active" }).eq("id", id);

    const events = await eventsFor(id);
    expect(events.map(({ event_type }) => event_type)).toEqual([
      "ai_system.created",
      "ai_system.updated",
      "ai_system.archived",
      "ai_system.unarchived",
    ]);
    expect(new Set(events.map(({ actor_user_id }) => actor_user_id))).toEqual(
      new Set([owner.id]),
    );
    expect(new Set(events.map(({ entity_type }) => entity_type))).toEqual(
      new Set(["ai_system"]),
    );
    expect(events[1]?.metadata).toEqual({
      fields: ["system_type", "provider"],
    });
  });

  it("the service role, with no user to name, cannot create a system", async () => {
    const name = `Service ${randomUUID().slice(0, 8)}`;

    const { error } = await fixtures.admin.from("ai_systems").insert({
      organization_id: organization.id,
      name,
      system_type: "other",
    });

    expect(error?.code).toBe("42501");
    const { count } = await fixtures.admin
      .from("ai_systems")
      .select("id", { count: "exact", head: true })
      .eq("name", name);
    expect(count).toBe(0);
  });

  it("a failed audit write undoes the change: the refused service-role edit leaves the row as it was", async () => {
    const { data: created } = await create({
      name: `Untouched ${randomUUID().slice(0, 8)}`,
      system_type: "chatbot",
    });

    const { error } = await fixtures.admin
      .from("ai_systems")
      .update({ description: "Changed by nobody" })
      .eq("id", created?.id as string);

    expect(error?.code).toBe("42501");
    const { data } = await fixtures.admin
      .from("ai_systems")
      .select("description")
      .eq("id", created?.id as string)
      .single();
    expect(data?.description).toBeNull();
  });
});
