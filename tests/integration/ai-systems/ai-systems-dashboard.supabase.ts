import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The dashboard's AI system actions against the real local database
 * (TASK-010): what a member does from the screens, end to end below the
 * browser. Isolation is in tests/security/ai-systems.
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
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import {
  createAiSystemAction,
  setAiSystemStatusAction,
  updateAiSystemAction,
} from "@/app/(dashboard)/dashboard/[organizationId]/systems/actions";
import AiSystemPage from "@/app/(dashboard)/dashboard/[organizationId]/systems/[systemId]/page";
import { renderPage, runAction } from "@/tests/support/next-interrupts";
import { actAs } from "@/tests/security/tenant-isolation/support/acting-user";
import {
  createTenantFixtures,
  type TestOrganization,
  type TestUser,
} from "@/tests/security/tenant-isolation/support/tenants";

const fixtures = createTenantFixtures();

let member: TestUser;
let org: TestOrganization;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    data.append(name, value);
  }
  return data;
}

function systemForm(fields: Record<string, string> = {}) {
  return form({
    name: `System ${randomUUID().slice(0, 8)}`,
    systemType: "chatbot",
    provider: "",
    description: "",
    ...fields,
  });
}

async function register(fields: Record<string, string> = {}) {
  const outcome = await runAction(() =>
    createAiSystemAction(org.id, null, systemForm(fields)),
  );
  if (outcome.kind !== "redirect") {
    throw new Error(`not registered: ${JSON.stringify(outcome)}`);
  }
  return outcome.location.split("/").at(-1) ?? "";
}

async function setStatus(id: string, status: string) {
  return runAction(() =>
    setAiSystemStatusAction(org.id, id, status, null, form({})),
  );
}

/** The version the edit form would have loaded, as the database prints it. */
async function versionOf(id: string): Promise<string> {
  const { data } = await fixtures.admin
    .from("ai_systems")
    .select("updated_at")
    .eq("id", id)
    .single();
  return data?.updated_at as string;
}

async function row(id: string) {
  const { data } = await fixtures.admin
    .from("ai_systems")
    .select("name, system_type, provider, description, status")
    .eq("id", id)
    .single();
  return data;
}

beforeAll(async () => {
  member = await fixtures.createUser();
  const client = await fixtures.signedInClient(member);
  const owner = await fixtures.createUser();
  org = await fixtures.createOrganization({ ownerId: owner.id });
  await fixtures.addMember(org.id, member.id, "member");
  actAs(member, client);
}, 30_000);

afterAll(async () => {
  await fixtures.cleanup();
});

describe("a member, from the dashboard", () => {
  it("registers a system and is taken to it", async () => {
    const name = `Support bot ${randomUUID().slice(0, 8)}`;

    const outcome = await runAction(() =>
      createAiSystemAction(
        org.id,
        null,
        systemForm({
          name: `  ${name}  `,
          systemType: "voice_agent",
          provider: "Acme",
          description: "Answers calls.\r\nIn English.",
        }),
      ),
    );

    expect(outcome.kind).toBe("redirect");
    const id =
      outcome.kind === "redirect"
        ? (outcome.location.split("/").at(-1) ?? "")
        : "";
    expect(outcome).toEqual({
      kind: "redirect",
      location: `/dashboard/${org.id}/systems/${id}`,
    });
    expect(await row(id)).toEqual({
      name,
      system_type: "voice_agent",
      provider: "Acme",
      description: "Answers calls.\nIn English.",
      status: "active",
    });
    const page = await renderPage(() =>
      AiSystemPage({
        params: Promise.resolve({ organizationId: org.id, systemId: id }),
      }),
    );
    expect(page.kind === "rendered" && page.html).toContain(name);
  });

  it("edits it, and the form shows what was stored", async () => {
    const id = await register({ provider: "Acme", description: "Old." });
    const name = `Renamed ${randomUUID().slice(0, 8)}`;
    const loaded = await versionOf(id);

    const outcome = await runAction(() =>
      updateAiSystemAction(
        org.id,
        id,
        null,
        systemForm({
          name: `${name}   `,
          systemType: "assistant",
          provider: "",
          description: "",
          expectedUpdatedAt: loaded,
        }),
      ),
    );

    const stored = await versionOf(id);
    expect(stored).not.toBe(loaded);
    expect(outcome).toEqual({
      kind: "returned",
      value: {
        result: "saved",
        fields: [],
        values: {
          name,
          systemType: "assistant",
          provider: "",
          description: "",
        },
        // The next edit names the version just stored.
        version: stored,
      },
    });
    expect(await row(id)).toMatchObject({
      name,
      system_type: "assistant",
      provider: null,
      description: null,
    });
  });

  it("audits only the fields that changed, though the form sends all four", async () => {
    const name = `Audited ${randomUUID().slice(0, 8)}`;
    const id = await register({ name, provider: "Acme" });
    const loaded = await versionOf(id);

    await runAction(() =>
      updateAiSystemAction(
        org.id,
        id,
        null,
        systemForm({
          name,
          provider: "Acme",
          description: "Now described.",
          expectedUpdatedAt: loaded,
        }),
      ),
    );

    const { data } = await fixtures.admin
      .from("audit_events")
      .select("event_type, metadata")
      .eq("entity_id", id)
      .eq("event_type", "ai_system.updated");
    expect(data).toEqual([
      {
        event_type: "ai_system.updated",
        metadata: { fields: ["description"] },
      },
    ]);
  });

  it("is told a name is taken, and keeps what they typed", async () => {
    const name = `Taken ${randomUUID().slice(0, 8)}`;
    await register({ name });

    const typed = {
      name: name.toUpperCase(),
      systemType: "generator",
      provider: "Someone",
      description: "Typed with care.",
    };
    const outcome = await runAction(() =>
      createAiSystemAction(org.id, null, form(typed)),
    );

    expect(outcome).toEqual({
      kind: "returned",
      value: { result: "name_taken", fields: [], values: typed },
    });
  });

  it("is told which fields to fix, and nothing is written", async () => {
    const provider = `Provider ${randomUUID().slice(0, 8)}`;

    const outcome = await runAction(() =>
      createAiSystemAction(
        org.id,
        null,
        systemForm({ name: "", systemType: "robot", provider }),
      ),
    );

    expect(outcome).toMatchObject({
      kind: "returned",
      value: { result: "invalid", fields: ["name", "systemType"] },
    });
    const { count } = await fixtures.admin
      .from("ai_systems")
      .select("id", { count: "exact", head: true })
      .eq("provider", provider);
    expect(count).toBe(0);
  });

  it("archives and restores it", async () => {
    const id = await register();

    expect(await setStatus(id, "archived")).toEqual({
      kind: "returned",
      value: { result: "archived" },
    });
    expect((await row(id))?.status).toBe("archived");

    expect(await setStatus(id, "active")).toEqual({
      kind: "returned",
      value: { result: "restored" },
    });
    expect((await row(id))?.status).toBe("active");
  });

  it("cannot restore a system while another active one has its name", async () => {
    const name = `Twin ${randomUUID().slice(0, 8)}`;
    const first = await register({ name });
    await setStatus(first, "archived");
    await register({ name });

    expect(await setStatus(first, "active")).toEqual({
      kind: "returned",
      value: { result: "name_taken" },
    });
    expect((await row(first))?.status).toBe("archived");
  });

  it("two people editing one system: the second save is refused, not applied over the first (TASK-010 review)", async () => {
    const name = `Shared ${randomUUID().slice(0, 8)}`;
    const id = await register({ name, provider: "Original" });
    // Both open the edit form now, and so both hold this version.
    const loaded = await versionOf(id);

    // Ben changes the provider and saves first.
    const ben = await runAction(() =>
      updateAiSystemAction(
        org.id,
        id,
        null,
        systemForm({
          name,
          provider: "Ben's vendor",
          expectedUpdatedAt: loaded,
        }),
      ),
    );
    // Anna fixed the name, with the provider as she loaded it, and saves second.
    const annaTyped = {
      name: `${name} fixed`,
      systemType: "chatbot",
      provider: "Original",
      description: "",
      expectedUpdatedAt: loaded,
    };
    const anna = await runAction(() =>
      updateAiSystemAction(org.id, id, null, form(annaTyped)),
    );

    expect(ben).toMatchObject({ value: { result: "saved" } });
    expect(anna).toEqual({
      kind: "returned",
      value: {
        result: "stale",
        fields: [],
        values: {
          name: annaTyped.name,
          systemType: "chatbot",
          provider: "Original",
          description: "",
        },
      },
    });
    // Ben's change stands, and Anna's rename wasn't applied either.
    expect(await row(id)).toMatchObject({ name, provider: "Ben's vendor" });
  });

  it("an edit that names no version is refused, and nothing is written", async () => {
    const name = `Unversioned ${randomUUID().slice(0, 8)}`;
    const id = await register({ name });

    for (const version of [undefined, "", "not-a-timestamp"]) {
      const outcome = await runAction(() =>
        updateAiSystemAction(
          org.id,
          id,
          null,
          systemForm({
            name: `${name} changed`,
            ...(version === undefined ? {} : { expectedUpdatedAt: version }),
          }),
        ),
      );
      expect(outcome).toMatchObject({ value: { result: "stale" } });
    }
    expect((await row(id))?.name).toBe(name);
  });

  it("archiving needs no version, and a later edit names the new one", async () => {
    const id = await register();
    const before = await versionOf(id);

    expect(await setStatus(id, "archived")).toMatchObject({
      value: { result: "archived" },
    });

    const after = await versionOf(id);
    expect(after).not.toBe(before);
    const stale = await runAction(() =>
      updateAiSystemAction(
        org.id,
        id,
        null,
        systemForm({ expectedUpdatedAt: before }),
      ),
    );
    const current = await runAction(() =>
      updateAiSystemAction(
        org.id,
        id,
        null,
        systemForm({ expectedUpdatedAt: after }),
      ),
    );
    expect(stale).toMatchObject({ value: { result: "stale" } });
    expect(current).toMatchObject({ value: { result: "saved" } });
  });
});
