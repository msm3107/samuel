import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * README §8's isolation checks for deployments through the routes, against
 * the real local database (TASK-013). deployments.supabase.ts in
 * tests/security/tenant-isolation (if any) proves the same boundary in RLS
 * alone; this proves the routes on top of it add no way around it.
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

import { POST as createSystem } from "@/app/api/organizations/[organizationId]/ai-systems/route";
import {
  GET as getDeployment,
  PATCH as patchDeployment,
} from "@/app/api/organizations/[organizationId]/deployments/[deploymentId]/route";
import {
  GET as listDeployments,
  POST as createDeployment,
} from "@/app/api/organizations/[organizationId]/deployments/route";
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
let deploymentA: string;

let userB: TestUser;
let clientB: SupabaseClient;
let orgB: TestOrganization;
let systemB: string;
let deploymentB: string;

let viewerOfA: TestUser;
let viewerClient: SupabaseClient;

function hostname(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}.example.com`;
}

function collection(organizationId: string, query = "") {
  const path = `/api/organizations/${organizationId}/deployments${query}`;
  return {
    path,
    context: { params: Promise.resolve({ organizationId }) },
  };
}

function item(organizationId: string, deploymentId: string) {
  return {
    path: `/api/organizations/${organizationId}/deployments/${deploymentId}`,
    context: { params: Promise.resolve({ organizationId, deploymentId }) },
  };
}

async function createDeploymentAs(
  user: TestUser,
  client: SupabaseClient,
  organizationId: string,
  body: unknown,
) {
  actAs(user, client);
  const { path, context } = collection(organizationId);
  return createDeployment(apiRequest("POST", path, { body }), context);
}

async function createSystemAs(
  user: TestUser,
  client: SupabaseClient,
  organizationId: string,
) {
  actAs(user, client);
  const response = await createSystem(
    apiRequest("POST", `/api/organizations/${organizationId}/ai-systems`, {
      body: { name: `Sys ${randomUUID().slice(0, 8)}`, systemType: "chatbot" },
    }),
    { params: Promise.resolve({ organizationId }) },
  );
  const { aiSystem } = (await response.json()) as { aiSystem: { id: string } };
  return aiSystem.id;
}

async function deploymentRow(id: string) {
  const { data } = await fixtures.admin
    .from("deployments")
    .select("organization_id, ai_system_id, hostname, status")
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

  systemA = await createSystemAs(userA, clientA, orgA.id);
  systemB = await createSystemAs(userB, clientB, orgB.id);

  const a = await createDeploymentAs(userA, clientA, orgA.id, {
    aiSystemId: systemA,
    hostname: hostname("a-dep"),
  });
  deploymentA = ((await a.json()) as { deployment: { id: string } }).deployment
    .id;

  const b = await createDeploymentAs(userB, clientB, orgB.id, {
    aiSystemId: systemB,
    hostname: hostname("b-dep"),
  });
  deploymentB = ((await b.json()) as { deployment: { id: string } }).deployment
    .id;
}, 30_000);

afterAll(async () => {
  await fixtures.cleanup();
});

describe("user A and organization B's deployments", () => {
  it("cannot list B's deployments: 403, the same as for any organization A is not in", async () => {
    actAs(userA, clientA);

    for (const organizationId of [orgB.id, randomUUID()]) {
      const { path, context } = collection(organizationId, "?status=all");
      const response = await listDeployments(apiRequest("GET", path), context);
      expect(response.status).toBe(403);
      expect((await readError(response)).code).toBe(
        "organization_access_denied",
      );
    }
  });

  it("cannot read B's deployment under B's organization", async () => {
    actAs(userA, clientA);
    const { path, context } = item(orgB.id, deploymentB);

    const response = await getDeployment(apiRequest("GET", path), context);

    expect(response.status).toBe(403);
  });

  it("gets a 404 for B's deployment under A's own organization, the same as one that doesn't exist", async () => {
    actAs(userA, clientA);

    for (const deploymentId of [deploymentB, randomUUID(), "not-a-uuid"]) {
      const { path, context } = item(orgA.id, deploymentId);
      const response = await getDeployment(apiRequest("GET", path), context);
      expect(response.status).toBe(404);
      expect((await readError(response)).code).toBe("deployment_not_found");
    }
  });

  it("cannot create a deployment in B, and nothing is inserted", async () => {
    actAs(userA, clientA);
    const host = hostname("planted");

    const response = await createDeploymentAs(userA, clientA, orgB.id, {
      aiSystemId: systemB,
      hostname: host,
    });

    expect(response.status).toBe(403);
    const { count } = await fixtures.admin
      .from("deployments")
      .select("id", { count: "exact", head: true })
      .eq("hostname", host);
    expect(count).toBe(0);
  });

  it("cannot archive B's deployment, under either organization's URL", async () => {
    actAs(userA, clientA);
    const before = await deploymentRow(deploymentB);

    const underB = item(orgB.id, deploymentB);
    const viaB = await patchDeployment(
      apiRequest("PATCH", underB.path, { body: { status: "archived" } }),
      underB.context,
    );
    const underA = item(orgA.id, deploymentB);
    const viaA = await patchDeployment(
      apiRequest("PATCH", underA.path, { body: { status: "archived" } }),
      underA.context,
    );

    expect(viaB.status).toBe(403);
    expect(viaA.status).toBe(404);
    expect(await deploymentRow(deploymentB)).toEqual(before);
  });

  it("creating in A with B's aiSystemId is 404 ai_system_not_found, revealing nothing about B's system", async () => {
    actAs(userA, clientA);

    const response = await createDeploymentAs(userA, clientA, orgA.id, {
      aiSystemId: systemB,
      hostname: hostname("wrong-system"),
    });

    expect(response.status).toBe(404);
    expect((await readError(response)).code).toBe("ai_system_not_found");
  });

  it("?aiSystemId=<B's system> under A lists nothing", async () => {
    actAs(userA, clientA);
    const { path, context } = collection(
      orgA.id,
      `?status=all&aiSystemId=${systemB}`,
    );

    const response = await listDeployments(apiRequest("GET", path), context);

    expect(response.status).toBe(200);
    const { deployments } = (await response.json()) as {
      deployments: unknown[];
    };
    expect(deployments).toEqual([]);
  });

  it("lists only A's deployments under A", async () => {
    actAs(userA, clientA);
    const { path, context } = collection(orgA.id, "?status=all");

    const response = await listDeployments(apiRequest("GET", path), context);

    const { deployments } = (await response.json()) as {
      deployments: { id: string }[];
    };
    const ids = deployments.map(({ id }) => id);
    expect(ids).toContain(deploymentA);
    expect(ids).not.toContain(deploymentB);
  });
});

describe("roles", () => {
  it("a viewer lists and reads A's deployments", async () => {
    actAs(viewerOfA, viewerClient);

    const list = collection(orgA.id);
    const listed = await listDeployments(
      apiRequest("GET", list.path),
      list.context,
    );
    const one = item(orgA.id, deploymentA);
    const read = await getDeployment(apiRequest("GET", one.path), one.context);

    expect(listed.status).toBe(200);
    expect(read.status).toBe(200);
  });

  it("a viewer cannot create or archive: 403 before the body is read, and nothing changes", async () => {
    actAs(viewerOfA, viewerClient);
    const before = await deploymentRow(deploymentA);

    const created = await createDeploymentAs(viewerOfA, viewerClient, orgA.id, {
      not: "even valid",
    });
    const one = item(orgA.id, deploymentA);
    const archived = await patchDeployment(
      apiRequest("PATCH", one.path, { body: { status: "archived" } }),
      one.context,
    );

    expect(created.status).toBe(403);
    expect(archived.status).toBe(403);
    expect(await deploymentRow(deploymentA)).toEqual(before);
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
      const host = hostname("smuggled");

      const response = await createDeploymentAs(userA, clientA, orgA.id, {
        aiSystemId: systemA,
        hostname: host,
        [field]: value(),
      });

      expect(response.status).toBe(400);
      const { count } = await fixtures.admin
        .from("deployments")
        .select("id", { count: "exact", head: true })
        .eq("hostname", host);
      expect(count).toBe(0);
    },
  );
});

describe("hostnames TASK-012 refuses", () => {
  it("a private-network hostname is refused, and nothing is stored", async () => {
    actAs(userA, clientA);

    const response = await createDeploymentAs(userA, clientA, orgA.id, {
      aiSystemId: systemA,
      hostname: "metadata-service.internal",
    });

    expect(response.status).toBe(400);
    expect((await readError(response)).code).toBe("hostname_private_network");
    const { count } = await fixtures.admin
      .from("deployments")
      .select("id", { count: "exact", head: true })
      .eq("hostname", "metadata-service.internal");
    expect(count).toBe(0);
  });
});
