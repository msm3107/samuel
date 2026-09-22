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
 * The life of a disclosure through the Data API as a signed-in member
 * (TASK-016): publish, publish again, the message/language/archived-system
 * rules as a user sees them, the PLAN Phase 5 exit criterion (an update
 * fails at the database level, for a user and for the service role),
 * concurrent publishes, and the audit trail. What the database guarantees
 * before TASK-017's versioning service exists.
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

async function createSystem(): Promise<string> {
  const { data, error } = await client
    .from("ai_systems")
    .insert({
      organization_id: organization.id,
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

function message(label: string) {
  return `${label} ${randomUUID().slice(0, 8)}.`;
}

function publish(
  aiSystemId: string,
  text: string,
  options: { language?: string; enabled?: boolean } = {},
) {
  return client
    .from("disclosures")
    .insert({
      organization_id: organization.id,
      ai_system_id: aiSystemId,
      message: text,
      language: options.language ?? "en",
      enabled: options.enabled ?? true,
    })
    .select()
    .single();
}

const EU_LANGUAGES = [
  "bg",
  "cs",
  "da",
  "de",
  "el",
  "en",
  "es",
  "et",
  "fi",
  "fr",
  "ga",
  "hr",
  "hu",
  "it",
  "lt",
  "lv",
  "mt",
  "nl",
  "pl",
  "pt",
  "ro",
  "sk",
  "sl",
  "sv",
];

describe("a disclosure's life", () => {
  it("is published as version 1, with the database's id, version and author", async () => {
    const system = await createSystem();

    const { data, error } = await publish(system, message("First"));

    expect(error).toBeNull();
    expect(data).toMatchObject({
      organization_id: organization.id,
      ai_system_id: system,
      version: 1,
      enabled: true,
      created_by: owner.id,
    });
    expect(data?.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("numbers versions 1, 2, 3 in order", async () => {
    const system = await createSystem();

    const v1 = await publish(system, message("V1"));
    const v2 = await publish(system, message("V2"));
    const v3 = await publish(system, message("V3"));

    expect(v1.error).toBeNull();
    expect(v2.error).toBeNull();
    expect(v3.error).toBeNull();
    expect([v1.data?.version, v2.data?.version, v3.data?.version]).toEqual([
      1, 2, 3,
    ]);
  });

  it("turning the disclosure off publishes a new version, not an edit", async () => {
    const system = await createSystem();
    const { data: on } = await publish(system, message("On"));

    const { data: off, error } = await publish(system, message("Off"), {
      enabled: false,
    });

    expect(error).toBeNull();
    expect(off?.version).toBe((on?.version as number) + 1);
    expect(off?.enabled).toBe(false);
    // The version it turned off is untouched.
    const { data: stillOn } = await client
      .from("disclosures")
      .select("enabled")
      .eq("id", on?.id as string)
      .single();
    expect(stillOn?.enabled).toBe(true);
  });
});

describe("the message, language and archived-system rules, as a user sees them", () => {
  it("refuses an unacceptable message, deterministically", async () => {
    const system = await createSystem();

    for (const text of [
      "",
      " Leading space.",
      "Trailing space. ",
      "x".repeat(501),
      "Two\nlines.",
      "Bell\x07here.",
    ]) {
      const { error } = await publish(system, text);
      expect(error?.code, JSON.stringify(text)).toBe("23514");
    }
  });

  it("accepts every official EU language and refuses one that isn't on the list", async () => {
    const system = await createSystem();

    for (const language of EU_LANGUAGES) {
      const { error } = await publish(system, message(language), {
        language,
      });
      expect(error, language).toBeNull();
    }

    const { error } = await publish(system, message("bad"), {
      language: "xx",
    });
    expect(error?.code).toBe("23514");
  });

  it("refuses a publish under an archived AI system, even one that only turns the disclosure off", async () => {
    const system = await createSystem();
    await client
      .from("ai_systems")
      .update({ status: "archived" })
      .eq("id", system);

    const on = await publish(system, message("Blocked"));
    const off = await publish(system, message("Blocked off"), {
      enabled: false,
    });

    // The code and the fixed hint are what TASK-017 matches, never the
    // message text (PR #31 review, note 3).
    expect(on.error?.code).toBe("23514");
    expect(on.error?.hint).toBe("ai_system_archived");
    expect(off.error?.code).toBe("23514");
    expect(off.error?.hint).toBe("ai_system_archived");
  });
});

describe("a published version is never changed (PLAN Phase 5 exit criterion)", () => {
  it("an update fails at the database level for a user, and the row is unchanged", async () => {
    const system = await createSystem();
    const { data: created } = await publish(system, message("Fixed"));

    const { error } = await client
      .from("disclosures")
      .update({ enabled: false })
      .eq("id", created?.id as string);

    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");

    const { data: reread } = await client
      .from("disclosures")
      .select()
      .eq("id", created?.id as string)
      .single();
    expect(reread).toEqual(created);
  });

  it("an update fails at the database level for the service role too, and the row is unchanged", async () => {
    const system = await createSystem();
    const { data: created } = await publish(
      system,
      message("Fixed for service role"),
    );

    const { error } = await fixtures.admin
      .from("disclosures")
      .update({ enabled: false })
      .eq("id", created?.id as string);

    expect(error).not.toBeNull();
    expect(error?.code).toBe("42501");

    const { data: reread } = await fixtures.admin
      .from("disclosures")
      .select()
      .eq("id", created?.id as string)
      .single();
    expect(reread).toEqual(created);
  });
});

describe("concurrent publishes for one system", () => {
  it("8 at once, from one member, get distinct, consecutive versions 1..8", async () => {
    const system = await createSystem();

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        publish(system, message(`Concurrent ${index}`)),
      ),
    );

    expect(results.every(({ error }) => error === null)).toBe(true);
    const versions = results
      .map(({ data }) => data?.version as number)
      .sort((a, b) => a - b);
    expect(versions).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    // Distinct: no two publishes were handed the same version.
    expect(new Set(versions).size).toBe(8);
  });
});

describe("every publish is audited", () => {
  it("writes disclosure.published, naming the signed-in user, with empty metadata", async () => {
    const system = await createSystem();
    const { data: created } = await publish(system, message("Audited"));

    const { data: events } = await fixtures.admin
      .from("audit_events")
      .select("actor_user_id, event_type, entity_type, metadata")
      .eq("entity_id", created?.id as string);

    expect(events).toEqual([
      {
        actor_user_id: owner.id,
        event_type: "disclosure.published",
        entity_type: "disclosure",
        metadata: {},
      },
    ]);
  });

  it("the service role, with no user to name, cannot publish", async () => {
    const system = await createSystem();

    const { error } = await fixtures.admin.from("disclosures").insert({
      organization_id: organization.id,
      ai_system_id: system,
      message: message("Service"),
      language: "en",
    });

    expect(error?.code).toBe("42501");
    const { count } = await fixtures.admin
      .from("disclosures")
      .select("id", { count: "exact", head: true })
      .eq("ai_system_id", system);
    expect(count).toBe(0);
  });
});
