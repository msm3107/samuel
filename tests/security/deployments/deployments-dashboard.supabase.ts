import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * README §8's isolation checks for deployments through the dashboard's
 * pages and server actions, against the real local database (TASK-015). The
 * routes are covered by deployments-api.supabase.ts, and RLS alone by
 * tests/security/tenant-isolation (if any).
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
  createDeploymentAction,
  setDeploymentStatusAction,
} from "@/app/(dashboard)/dashboard/[organizationId]/deployments/actions";
import DeploymentPage from "@/app/(dashboard)/dashboard/[organizationId]/deployments/[deploymentId]/page";
import { createAiSystemAction } from "@/app/(dashboard)/dashboard/[organizationId]/systems/actions";
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
let deploymentA: string;

let userB: TestUser;
let clientB: SupabaseClient;
let orgB: TestOrganization;
let systemB: string;
let deploymentB: string;

let viewerOfA: TestUser;
let viewerClient: SupabaseClient;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    data.append(name, value);
  }
  return data;
}

function deploymentForm(hostname: string, extra: Record<string, string> = {}) {
  return form({ hostname, ...extra });
}

function hostname(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}.example.com`;
}

function systemForm(name: string) {
  return form({ name, systemType: "chatbot", provider: "", description: "" });
}

function deploymentPage(organizationId: string, deploymentId: string) {
  return renderPage(() =>
    DeploymentPage({
      params: Promise.resolve({ organizationId, deploymentId }),
    }),
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

/** Registers an AI system through the action, as the signed-in actor. */
async function registerSystem(organizationId: string, name: string) {
  const outcome = await runAction(() =>
    createAiSystemAction(organizationId, null, systemForm(name)),
  );
  if (outcome.kind !== "redirect") {
    throw new Error(`system not registered: ${JSON.stringify(outcome)}`);
  }
  return outcome.location.split("/").at(-1) ?? "";
}

/** Registers a deployment through the action, as the signed-in actor. */
async function registerDeployment(
  organizationId: string,
  aiSystemId: string,
  host: string,
) {
  const outcome = await runAction(() =>
    createDeploymentAction(
      organizationId,
      aiSystemId,
      null,
      deploymentForm(host),
    ),
  );
  if (outcome.kind !== "redirect") {
    throw new Error(`deployment not registered: ${JSON.stringify(outcome)}`);
  }
  return outcome.location.split("/").at(-1) ?? "";
}

async function deploymentRow(id: string) {
  const { data } = await fixtures.admin
    .from("deployments")
    .select("organization_id, ai_system_id, hostname, status, public_id")
    .eq("id", id)
    .single();
  return data;
}

async function countWithHostname(aiSystemId: string, host: string) {
  const { count } = await fixtures.admin
    .from("deployments")
    .select("id", { count: "exact", head: true })
    .eq("ai_system_id", aiSystemId)
    .eq("hostname", host);
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
  systemA = await registerSystem(orgA.id, "A's Bot");
  deploymentA = await registerDeployment(orgA.id, systemA, hostname("a-dep"));

  actAs(userB, clientB);
  systemB = await registerSystem(orgB.id, "B's Bot");
  deploymentB = await registerDeployment(orgB.id, systemB, hostname("b-dep"));
}, 30_000);

afterAll(async () => {
  await fixtures.cleanup();
});

describe("user A's pages and organization B", () => {
  it("B's system, and any organization A is not in, is not found", async () => {
    actAs(userA, clientA);

    for (const organizationId of [orgB.id, randomUUID(), "not-a-uuid"]) {
      expect(await systemPage(organizationId, systemA)).toEqual({
        kind: "not_found",
      });
    }
    for (const systemId of [systemB, randomUUID(), "not-a-uuid"]) {
      expect(await systemPage(orgA.id, systemId)).toEqual({
        kind: "not_found",
      });
    }
  });

  it("B's deployment is not found under either organization, like one that does not exist", async () => {
    actAs(userA, clientA);

    expect(await deploymentPage(orgB.id, deploymentB)).toEqual({
      kind: "not_found",
    });
    for (const deploymentId of [deploymentB, randomUUID(), "not-a-uuid"]) {
      expect(await deploymentPage(orgA.id, deploymentId)).toEqual({
        kind: "not_found",
      });
    }
  });

  it("a signed-out visitor is sent to sign-in, from both pages", async () => {
    actAsNobody();

    expect(await systemPage(orgA.id, systemA)).toEqual({
      kind: "redirect",
      location: "/sign-in",
    });
    expect(await deploymentPage(orgA.id, deploymentA)).toEqual({
      kind: "redirect",
      location: "/sign-in",
    });
  });
});

describe("user A's actions and organization B", () => {
  it("cannot register a deployment in B", async () => {
    actAs(userA, clientA);
    const host = hostname("planted");

    const outcome = await runAction(() =>
      createDeploymentAction(orgB.id, systemB, null, deploymentForm(host)),
    );

    expect(outcome).toMatchObject({ value: { result: "not_permitted" } });
    expect(await countWithHostname(systemB, host)).toBe(0);
  });

  it("cannot archive B's deployment, bound to either organization", async () => {
    actAs(userA, clientA);
    const before = await deploymentRow(deploymentB);

    const viaB = await runAction(() =>
      setDeploymentStatusAction(
        orgB.id,
        deploymentB,
        "archived",
        null,
        form({}),
      ),
    );
    const viaA = await runAction(() =>
      setDeploymentStatusAction(
        orgA.id,
        deploymentB,
        "archived",
        null,
        form({}),
      ),
    );

    expect(viaB).toMatchObject({ value: { result: "not_permitted" } });
    expect(viaA).toMatchObject({ value: { result: "not_found" } });
    expect(await deploymentRow(deploymentB)).toEqual(before);
  });

  it("a signed-out request is sent to sign-in and writes nothing", async () => {
    actAsNobody();
    const host = hostname("anonymous");

    const outcome = await runAction(() =>
      createDeploymentAction(orgA.id, systemA, null, deploymentForm(host)),
    );

    expect(outcome).toEqual({ kind: "redirect", location: "/sign-in" });
    expect(await countWithHostname(systemA, host)).toBe(0);
  });
});

describe("forged arguments and fields", () => {
  it("a smuggled organization, system, status or public ID in the form is ignored", async () => {
    actAs(userA, clientA);
    const host = hostname("smuggled");
    const forgedId = randomUUID();

    const outcome = await runAction(() =>
      createDeploymentAction(
        orgA.id,
        systemA,
        null,
        deploymentForm(host, {
          organizationId: orgB.id,
          aiSystemId: systemB,
          id: forgedId,
          status: "archived",
          public_id: "dep_forged00000000000000000",
          publicId: "dep_forged00000000000000000",
        }),
      ),
    );

    expect(outcome.kind).toBe("redirect");
    const location = outcome.kind === "redirect" ? outcome.location : "";
    const id = location.split("/").at(-1) ?? "";
    expect(location).toBe(`/dashboard/${orgA.id}/deployments/${id}`);
    expect(id).not.toBe(forgedId);
    const row = await deploymentRow(id);
    expect(row).toMatchObject({
      organization_id: orgA.id,
      ai_system_id: systemA,
      hostname: host,
      status: "active",
    });
    expect(row?.public_id).not.toBe("dep_forged00000000000000000");
    expect(row?.public_id).toMatch(/^dep_[a-z2-7]{26}$/);
  });

  it("a bound organization that is not a UUID is refused before any write", async () => {
    actAs(userA, clientA);
    const host = hostname("forged-org");

    const outcome = await runAction(() =>
      createDeploymentAction(
        `${orgA.id}' or 1=1`,
        systemA,
        null,
        deploymentForm(host),
      ),
    );

    expect(outcome).toMatchObject({ value: { result: "not_permitted" } });
    expect(await countWithHostname(systemA, host)).toBe(0);
  });

  it("a bound AI system that is B's, or not a UUID, is refused as not found", async () => {
    actAs(userA, clientA);
    const hostViaB = hostname("forged-system-b");
    const hostNonUuid = hostname("forged-system-shape");

    const viaBSystem = await runAction(() =>
      createDeploymentAction(orgA.id, systemB, null, deploymentForm(hostViaB)),
    );
    const nonUuid = await runAction(() =>
      createDeploymentAction(
        orgA.id,
        "not-a-uuid",
        null,
        deploymentForm(hostNonUuid),
      ),
    );

    expect(viaBSystem).toMatchObject({
      value: { result: "ai_system_not_found" },
    });
    expect(nonUuid).toMatchObject({
      value: { result: "ai_system_not_found" },
    });
    expect(await countWithHostname(systemB, hostViaB)).toBe(0);
  });

  it("a bound deployment ID that is B's is refused as not found", async () => {
    actAs(userA, clientA);

    const outcome = await runAction(() =>
      setDeploymentStatusAction(
        orgA.id,
        deploymentB,
        "archived",
        null,
        form({}),
      ),
    );

    expect(outcome).toEqual({
      kind: "returned",
      value: { result: "not_found" },
    });
    expect((await deploymentRow(deploymentB))?.status).toBe("active");
  });

  it("a bound status other than active or archived is refused", async () => {
    actAs(userA, clientA);

    for (const status of ["deleted", "ARCHIVED", ""]) {
      const outcome = await runAction(() =>
        setDeploymentStatusAction(orgA.id, deploymentA, status, null, form({})),
      );
      expect(outcome).toEqual({
        kind: "returned",
        value: { result: "invalid" },
      });
    }
    expect((await deploymentRow(deploymentA))?.status).toBe("active");
  });
});

describe("a viewer", () => {
  it("sees the system and deployment pages without any write control", async () => {
    actAs(viewerOfA, viewerClient);

    const page = [
      html(await systemPage(orgA.id, systemA)),
      html(await deploymentPage(orgA.id, deploymentA)),
    ].join("");

    expect(page).not.toContain("Register hostname");
    expect(page).not.toContain("Archive this deployment");
    expect(page).not.toContain("Restore this deployment");
  });

  it("is refused by every write action, and nothing changes", async () => {
    actAs(viewerOfA, viewerClient);
    const host = hostname("by-viewer");
    const before = await deploymentRow(deploymentA);

    const outcomes = [
      await runAction(() =>
        createDeploymentAction(orgA.id, systemA, null, deploymentForm(host)),
      ),
      await runAction(() =>
        setDeploymentStatusAction(
          orgA.id,
          deploymentA,
          "archived",
          null,
          form({}),
        ),
      ),
    ];

    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({
        kind: "returned",
        value: { result: "not_permitted" },
      });
    }
    expect(await countWithHostname(systemA, host)).toBe(0);
    expect(await deploymentRow(deploymentA)).toEqual(before);
  });
});

describe("hostnames TASK-012 refuses", () => {
  it.each(["localhost", "169.254.169.254", "http://[::1]/"])(
    "%s is never stored",
    async (typed) => {
      actAs(userA, clientA);
      const before = await countWithHostname(systemA, typed);

      const outcome = await runAction(() =>
        createDeploymentAction(orgA.id, systemA, null, deploymentForm(typed)),
      );

      expect(outcome).toMatchObject({
        value: { result: "hostname_private_network", value: typed },
      });
      expect(await countWithHostname(systemA, typed)).toBe(before);
    },
  );
});
