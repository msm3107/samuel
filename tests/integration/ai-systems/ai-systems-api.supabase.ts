import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The AI systems routes against the real local database (TASK-009): a
 * member's whole round trip, and what the database's audit triggers record
 * for it.
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

type Body = {
  aiSystem: {
    id: string;
    name: string;
    description: string | null;
    systemType: string;
    provider: string | null;
    status: string;
  };
};

const fixtures = createTenantFixtures();

let member: TestUser;
let memberClient: SupabaseClient;
let organization: TestOrganization;

beforeAll(async () => {
  const owner = await fixtures.createUser();
  organization = await fixtures.createOrganization({ ownerId: owner.id });
  member = await fixtures.createUser();
  await fixtures.addMember(organization.id, member.id, "member");
  memberClient = await fixtures.signedInClient(member);
}, 30_000);

afterAll(async () => {
  await fixtures.cleanup();
});

function uniqueName(label: string) {
  return `${label} ${randomUUID().slice(0, 8)}`;
}

async function create(body: unknown) {
  const organizationId = organization.id;
  return createSystem(
    apiRequest("POST", `/api/organizations/${organizationId}/ai-systems`, {
      body,
    }),
    { params: Promise.resolve({ organizationId }) },
  );
}

async function patch(systemId: string, body: unknown) {
  const organizationId = organization.id;
  return patchSystem(
    apiRequest(
      "PATCH",
      `/api/organizations/${organizationId}/ai-systems/${systemId}`,
      { body },
    ),
    { params: Promise.resolve({ organizationId, systemId }) },
  );
}

async function get(systemId: string) {
  const organizationId = organization.id;
  return getSystem(
    apiRequest(
      "GET",
      `/api/organizations/${organizationId}/ai-systems/${systemId}`,
    ),
    { params: Promise.resolve({ organizationId, systemId }) },
  );
}

async function list(query: string) {
  const organizationId = organization.id;
  const response = await listSystems(
    apiRequest(
      "GET",
      `/api/organizations/${organizationId}/ai-systems${query}`,
    ),
    { params: Promise.resolve({ organizationId }) },
  );
  return response;
}

describe("a member's round trip", () => {
  it("creates a system and gets exactly six fields back", async () => {
    actAs(member, memberClient);
    const name = uniqueName("Support Assistant");

    const response = await create({
      name: `  ${name}  `,
      systemType: "assistant",
      description: "Answers billing questions.\nEscalates to a person.",
      provider: "Anthropic",
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const { aiSystem } = (await response.json()) as Body;
    expect(Object.keys(aiSystem).sort()).toEqual([
      "description",
      "id",
      "name",
      "provider",
      "status",
      "systemType",
    ]);
    expect(aiSystem).toMatchObject({
      name,
      systemType: "assistant",
      provider: "Anthropic",
      status: "active",
    });

    const read = await get(aiSystem.id);
    expect(await read.json()).toEqual({ aiSystem });
  });

  it("edits, clears the provider, archives and un-archives, and the database audits each", async () => {
    actAs(member, memberClient);
    const created = (await (
      await create({
        name: uniqueName("Lifecycle"),
        systemType: "chatbot",
        provider: "OpenAI",
      })
    ).json()) as Body;
    const id = created.aiSystem.id;

    const edited = await patch(id, {
      systemType: "voice_agent",
      provider: null,
    });
    expect(edited.status).toBe(200);
    expect(((await edited.json()) as Body).aiSystem).toMatchObject({
      systemType: "voice_agent",
      provider: null,
    });

    const archived = await patch(id, { status: "archived" });
    expect(((await archived.json()) as Body).aiSystem.status).toBe("archived");
    const restored = await patch(id, { status: "active" });
    expect(((await restored.json()) as Body).aiSystem.status).toBe("active");

    const { data: events } = await fixtures.admin
      .from("audit_events")
      .select("actor_user_id, event_type, metadata")
      .eq("entity_id", id)
      .order("created_at")
      .order("event_type");
    expect(events).toEqual([
      {
        actor_user_id: member.id,
        event_type: "ai_system.created",
        metadata: {},
      },
      {
        actor_user_id: member.id,
        event_type: "ai_system.updated",
        metadata: { fields: ["system_type", "provider"] },
      },
      {
        actor_user_id: member.id,
        event_type: "ai_system.archived",
        metadata: {},
      },
      {
        actor_user_id: member.id,
        event_type: "ai_system.unarchived",
        metadata: {},
      },
    ]);
  });

  it("lists by status: active by default, archived, or all", async () => {
    actAs(member, memberClient);
    const active = (await (
      await create({ name: uniqueName("Listed Active"), systemType: "other" })
    ).json()) as Body;
    const toArchive = (await (
      await create({ name: uniqueName("Listed Archived"), systemType: "other" })
    ).json()) as Body;
    await patch(toArchive.aiSystem.id, { status: "archived" });

    async function idsFor(query: string) {
      const response = await list(query);
      expect(response.status).toBe(200);
      const { aiSystems } = (await response.json()) as {
        aiSystems: { id: string }[];
      };
      return aiSystems.map(({ id }) => id);
    }

    const whole = (await (await list("?status=all")).json()) as {
      truncated: boolean;
    };
    expect(whole.truncated).toBe(false);

    const byDefault = await idsFor("");
    const archived = await idsFor("?status=archived");
    const all = await idsFor("?status=all");

    expect(byDefault).toContain(active.aiSystem.id);
    expect(byDefault).not.toContain(toArchive.aiSystem.id);
    expect(archived).toEqual(expect.arrayContaining([toArchive.aiSystem.id]));
    expect(archived).not.toContain(active.aiSystem.id);
    expect(all).toEqual(
      expect.arrayContaining([active.aiSystem.id, toArchive.aiSystem.id]),
    );
  });

  it.each(["?status=deleted", "?status=active&status=archived"])(
    "refuses the filter %s with 400",
    async (query) => {
      actAs(member, memberClient);

      const response = await list(query);

      expect(response.status).toBe(400);
      expect((await readError(response)).code).toBe("invalid_request");
    },
  );
});

describe("names", () => {
  it("a duplicate active name, whatever the case, is a 409 on create, rename and un-archive", async () => {
    actAs(member, memberClient);
    const name = uniqueName("Twin");
    const first = (await (
      await create({ name, systemType: "chatbot" })
    ).json()) as Body;

    const clash = await create({
      name: name.toUpperCase(),
      systemType: "chatbot",
    });
    expect(clash.status).toBe(409);
    expect((await readError(clash)).code).toBe("ai_system_name_taken");

    const other = (await (
      await create({ name: uniqueName("Other"), systemType: "chatbot" })
    ).json()) as Body;
    const rename = await patch(other.aiSystem.id, { name });
    expect(rename.status).toBe(409);

    await patch(first.aiSystem.id, { status: "archived" });
    const reuse = await create({ name, systemType: "chatbot" });
    expect(reuse.status).toBe(201);
    const unarchive = await patch(first.aiSystem.id, { status: "active" });
    expect(unarchive.status).toBe(409);
  });

  it("two spellings of one accented name are one name: 409 (PR #23 review)", async () => {
    actAs(member, memberClient);
    const suffix = randomUUID().slice(0, 8);
    const composed = `Caf${String.fromCodePoint(0xe9)} ${suffix}`;
    const decomposed = `Cafe${String.fromCodePoint(0x301)} ${suffix}`;

    const first = await create({ name: composed, systemType: "chatbot" });
    const second = await create({ name: decomposed, systemType: "chatbot" });

    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
  });

  it("concurrent creations of one name: one 201, the rest 409, never a 500", async () => {
    actAs(member, memberClient);
    const name = uniqueName("Race");

    const statuses = (
      await Promise.all(
        Array.from({ length: 5 }, () => create({ name, systemType: "other" })),
      )
    )
      .map((response) => response.status)
      .sort();

    expect(statuses).toEqual([201, 409, 409, 409, 409]);
  });
});
