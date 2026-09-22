import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * README §8's isolation checks for AI systems through the dashboard's pages
 * and server actions, against the real local database (TASK-010). The
 * routes are covered by ai-systems-api.supabase.ts, and RLS alone by
 * tests/security/tenant-isolation/ai-systems.supabase.ts.
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
// Outside a Next.js request there is no cache to revalidate.
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  createAiSystemAction,
  setAiSystemStatusAction,
  updateAiSystemAction,
} from "@/app/(dashboard)/dashboard/[organizationId]/systems/actions";
import NewAiSystemPage from "@/app/(dashboard)/dashboard/[organizationId]/systems/new/page";
import AiSystemsPage from "@/app/(dashboard)/dashboard/[organizationId]/systems/page";
import AiSystemPage from "@/app/(dashboard)/dashboard/[organizationId]/systems/[systemId]/page";
import { renderPage, runAction } from "@/tests/support/next-interrupts";
import {
  actAs,
  actAsNobody,
} from "@/tests/security/tenant-isolation/support/acting-user";
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

function listPage(organizationId: string, status?: string) {
  return renderPage(() =>
    AiSystemsPage({
      params: Promise.resolve({ organizationId }),
      searchParams: Promise.resolve(status === undefined ? {} : { status }),
    }),
  );
}

function newPage(organizationId: string) {
  return renderPage(() =>
    NewAiSystemPage({ params: Promise.resolve({ organizationId }) }),
  );
}

function systemPage(organizationId: string, systemId: string) {
  return renderPage(() =>
    AiSystemPage({ params: Promise.resolve({ organizationId, systemId }) }),
  );
}

function html(outcome: Awaited<ReturnType<typeof renderPage>>): string {
  if (outcome.kind !== "rendered") {
    throw new Error(`expected a rendered page, got ${outcome.kind}`);
  }
  return outcome.html;
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    data.append(name, value);
  }
  return data;
}

function systemForm(name: string, extra: Record<string, string> = {}) {
  return form({
    name,
    systemType: "chatbot",
    provider: "",
    description: "",
    ...extra,
  });
}

/** Registers a system through the action, as the signed-in actor. */
async function register(organizationId: string, name: string) {
  const outcome = await runAction(() =>
    createAiSystemAction(organizationId, null, systemForm(name)),
  );
  if (outcome.kind !== "redirect") {
    throw new Error(`not registered: ${JSON.stringify(outcome)}`);
  }
  return outcome.location.split("/").at(-1) ?? "";
}

async function systemRow(id: string) {
  const { data } = await fixtures.admin
    .from("ai_systems")
    .select("organization_id, name, status, provider, description")
    .eq("id", id)
    .single();
  return data;
}

async function countNamed(name: string) {
  const { count } = await fixtures.admin
    .from("ai_systems")
    .select("id", { count: "exact", head: true })
    .eq("name", name);
  return count;
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
  systemA = await register(orgA.id, "A's Bot");
  actAs(userB, clientB);
  systemB = await register(orgB.id, "B's Bot");
}, 30_000);

afterAll(async () => {
  await fixtures.cleanup();
});

describe("user A's pages and organization B", () => {
  it("B's list, and any organization A is not in, is not found", async () => {
    actAs(userA, clientA);

    for (const organizationId of [orgB.id, randomUUID(), "not-a-uuid"]) {
      expect(await listPage(organizationId, "all")).toEqual({
        kind: "not_found",
      });
    }
  });

  it("B's registration page is not found", async () => {
    actAs(userA, clientA);

    expect(await newPage(orgB.id)).toEqual({ kind: "not_found" });
  });

  it("B's system is not found under either organization, like a system that does not exist", async () => {
    actAs(userA, clientA);

    expect(await systemPage(orgB.id, systemB)).toEqual({ kind: "not_found" });
    for (const systemId of [systemB, randomUUID(), "not-a-uuid"]) {
      expect(await systemPage(orgA.id, systemId)).toEqual({
        kind: "not_found",
      });
    }
  });

  it("A's list shows A's systems and nothing of B's", async () => {
    actAs(userA, clientA);

    const page = html(await listPage(orgA.id, "all"));

    expect(page).toContain("A&#x27;s Bot");
    expect(page).toContain(systemA);
    expect(page).not.toContain("B&#x27;s Bot");
    expect(page).not.toContain(systemB);
  });

  it("a signed-out visitor is sent to sign-in, from every page", async () => {
    actAsNobody();

    for (const page of [
      await listPage(orgA.id),
      await newPage(orgA.id),
      await systemPage(orgA.id, systemA),
    ]) {
      expect(page).toEqual({ kind: "redirect", location: "/sign-in" });
    }
  });
});

describe("user A's actions and organization B", () => {
  it("cannot register a system in B", async () => {
    actAs(userA, clientA);
    const name = `Planted ${randomUUID().slice(0, 8)}`;

    const outcome = await runAction(() =>
      createAiSystemAction(orgB.id, null, systemForm(name)),
    );

    expect(outcome).toMatchObject({
      kind: "returned",
      value: { result: "not_permitted" },
    });
    expect(await countNamed(name)).toBe(0);
  });

  it("cannot edit B's system, bound to either organization", async () => {
    actAs(userA, clientA);
    const before = await systemRow(systemB);

    // With B's real version, so only the organization can stop the edit.
    const { data } = await fixtures.admin
      .from("ai_systems")
      .select("updated_at")
      .eq("id", systemB)
      .single();
    const takeOver = () =>
      systemForm("Taken over", { expectedUpdatedAt: data?.updated_at });

    const viaB = await runAction(() =>
      updateAiSystemAction(orgB.id, systemB, null, takeOver()),
    );
    const viaA = await runAction(() =>
      updateAiSystemAction(orgA.id, systemB, null, takeOver()),
    );

    expect(viaB).toMatchObject({ value: { result: "not_permitted" } });
    expect(viaA).toMatchObject({ value: { result: "not_found" } });
    expect(await systemRow(systemB)).toEqual(before);
  });

  it("cannot archive B's system, bound to either organization", async () => {
    actAs(userA, clientA);

    const viaB = await runAction(() =>
      setAiSystemStatusAction(orgB.id, systemB, "archived", null, form({})),
    );
    const viaA = await runAction(() =>
      setAiSystemStatusAction(orgA.id, systemB, "archived", null, form({})),
    );

    expect(viaB).toEqual({
      kind: "returned",
      value: { result: "not_permitted" },
    });
    expect(viaA).toEqual({ kind: "returned", value: { result: "not_found" } });
    expect((await systemRow(systemB))?.status).toBe("active");
  });

  it("a signed-out request is sent to sign-in and writes nothing", async () => {
    actAsNobody();
    const name = `Anonymous ${randomUUID().slice(0, 8)}`;

    const outcome = await runAction(() =>
      createAiSystemAction(orgA.id, null, systemForm(name)),
    );

    expect(outcome).toEqual({ kind: "redirect", location: "/sign-in" });
    expect(await countNamed(name)).toBe(0);
  });
});

describe("forged arguments and fields", () => {
  it("a smuggled organization, ID or status in the form is ignored", async () => {
    actAs(userA, clientA);
    const name = `Smuggled ${randomUUID().slice(0, 8)}`;
    const forgedId = randomUUID();

    const outcome = await runAction(() =>
      createAiSystemAction(
        orgA.id,
        null,
        systemForm(name, {
          organizationId: orgB.id,
          organization_id: orgB.id,
          id: forgedId,
          status: "archived",
        }),
      ),
    );

    expect(outcome.kind).toBe("redirect");
    const location = outcome.kind === "redirect" ? outcome.location : "";
    const id = location.split("/").at(-1) ?? "";
    expect(location).toBe(`/dashboard/${orgA.id}/systems/${id}`);
    expect(id).not.toBe(forgedId);
    expect(await systemRow(id)).toMatchObject({
      organization_id: orgA.id,
      status: "active",
    });
  });

  it("a bound organization that is not a UUID is refused before any write", async () => {
    actAs(userA, clientA);
    const name = `Forged org ${randomUUID().slice(0, 8)}`;

    const outcome = await runAction(() =>
      createAiSystemAction(`${orgA.id}' or 1=1`, null, systemForm(name)),
    );

    expect(outcome).toMatchObject({ value: { result: "not_permitted" } });
    expect(await countNamed(name)).toBe(0);
  });

  it("a bound system ID that is not a UUID is not found", async () => {
    actAs(userA, clientA);

    const edit = await runAction(() =>
      updateAiSystemAction(orgA.id, "not-a-uuid", null, systemForm("X")),
    );
    const archive = await runAction(() =>
      setAiSystemStatusAction(
        orgA.id,
        "not-a-uuid",
        "archived",
        null,
        form({}),
      ),
    );

    expect(edit).toMatchObject({ value: { result: "not_found" } });
    expect(archive).toEqual({
      kind: "returned",
      value: { result: "not_found" },
    });
  });

  it("a bound status other than active or archived is refused", async () => {
    actAs(userA, clientA);

    for (const status of ["deleted", "ARCHIVED", ""]) {
      const outcome = await runAction(() =>
        setAiSystemStatusAction(orgA.id, systemA, status, null, form({})),
      );
      expect(outcome).toEqual({
        kind: "returned",
        value: { result: "invalid" },
      });
    }
    expect((await systemRow(systemA))?.status).toBe("active");
  });
});

describe("a viewer", () => {
  it("sees the list and a system without any write control", async () => {
    actAs(viewerOfA, viewerClient);

    const page = [
      html(await listPage(orgA.id)),
      html(await systemPage(orgA.id, systemA)),
    ].join("");

    expect(page).toContain("A&#x27;s Bot");
    expect(page).not.toContain("Register an AI system");
    expect(page).not.toContain("<form");
    expect(page).not.toContain("<button");
  });

  it("gets the not-found page for registration", async () => {
    actAs(viewerOfA, viewerClient);

    expect(await newPage(orgA.id)).toEqual({ kind: "not_found" });
  });

  it("is refused by every write action, and nothing changes", async () => {
    actAs(viewerOfA, viewerClient);
    const name = `By viewer ${randomUUID().slice(0, 8)}`;
    const before = await systemRow(systemA);

    const outcomes = [
      await runAction(() =>
        createAiSystemAction(orgA.id, null, systemForm(name)),
      ),
      await runAction(() =>
        updateAiSystemAction(orgA.id, systemA, null, systemForm(name)),
      ),
      await runAction(() =>
        setAiSystemStatusAction(orgA.id, systemA, "archived", null, form({})),
      ),
    ];

    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({
        kind: "returned",
        value: { result: "not_permitted" },
      });
    }
    expect(await countNamed(name)).toBe(0);
    expect(await systemRow(systemA)).toEqual(before);
  });
});

describe("a member", () => {
  it("sees the write controls the viewer does not", async () => {
    actAs(userA, clientA);

    const list = html(await listPage(orgA.id));
    const detail = html(await systemPage(orgA.id, systemA));

    expect(list).toContain("Register an AI system");
    expect(detail).toContain("Save changes");
    expect(detail).toContain("Archive this system");
  });

  it("an archived system is listed under Archived, not Active", async () => {
    actAs(userA, clientA);
    const name = `Archived ${randomUUID().slice(0, 8)}`;
    const id = await register(orgA.id, name);
    await runAction(() =>
      setAiSystemStatusAction(orgA.id, id, "archived", null, form({})),
    );

    expect(html(await listPage(orgA.id))).not.toContain(name);
    expect(html(await listPage(orgA.id, "archived"))).toContain(name);
    // An unknown filter shows the active systems.
    expect(html(await listPage(orgA.id, "everything"))).not.toContain(name);
  });
});
