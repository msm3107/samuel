import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The deployment routes against the real local database (TASK-013): a
 * member's whole round trip — creating, listing, archiving and restoring —
 * and what the database's audit triggers and constraints do around it
 * (unique active hostnames per system, and the archived-AI-system rule from
 * TASK-011).
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

import { PATCH as patchSystem } from "@/app/api/organizations/[organizationId]/ai-systems/[systemId]/route";
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

type DeploymentBody = {
  deployment: {
    id: string;
    aiSystemId: string;
    aiSystemStatus: string;
    hostname: string;
    unicodeHostname: string;
    status: string;
    createdAt: string;
    updatedAt: string;
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

function hostname(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}.example.com`;
}

/** A fresh AI system in the organization, created through its own route. */
async function makeSystem(): Promise<string> {
  actAs(member, memberClient);
  const response = await createSystem(
    apiRequest("POST", `/api/organizations/${organization.id}/ai-systems`, {
      body: {
        name: `Sys ${randomUUID().slice(0, 8)}`,
        systemType: "chatbot",
      },
    }),
    { params: Promise.resolve({ organizationId: organization.id }) },
  );
  const { aiSystem } = (await response.json()) as { aiSystem: { id: string } };
  return aiSystem.id;
}

async function archiveSystem(systemId: string): Promise<void> {
  actAs(member, memberClient);
  const response = await patchSystem(
    apiRequest(
      "PATCH",
      `/api/organizations/${organization.id}/ai-systems/${systemId}`,
      { body: { status: "archived" } },
    ),
    {
      params: Promise.resolve({
        organizationId: organization.id,
        systemId,
      }),
    },
  );
  expect(response.status).toBe(200);
}

async function create(body: unknown) {
  const organizationId = organization.id;
  return createDeployment(
    apiRequest("POST", `/api/organizations/${organizationId}/deployments`, {
      body,
    }),
    { params: Promise.resolve({ organizationId }) },
  );
}

async function patch(deploymentId: string, body: unknown) {
  const organizationId = organization.id;
  return patchDeployment(
    apiRequest(
      "PATCH",
      `/api/organizations/${organizationId}/deployments/${deploymentId}`,
      { body },
    ),
    { params: Promise.resolve({ organizationId, deploymentId }) },
  );
}

async function get(deploymentId: string) {
  const organizationId = organization.id;
  return getDeployment(
    apiRequest(
      "GET",
      `/api/organizations/${organizationId}/deployments/${deploymentId}`,
    ),
    { params: Promise.resolve({ organizationId, deploymentId }) },
  );
}

async function list(query: string) {
  const organizationId = organization.id;
  return listDeployments(
    apiRequest(
      "GET",
      `/api/organizations/${organizationId}/deployments${query}`,
    ),
    { params: Promise.resolve({ organizationId }) },
  );
}

describe("a member's round trip", () => {
  it("creates a deployment and gets back the documented fields, ASCII and Unicode", async () => {
    actAs(member, memberClient);
    const systemId = await makeSystem();
    const suffix = randomUUID().slice(0, 8);
    // An internationalized hostname: "bücher.de" is "xn--bcher-kva.de" in
    // punycode, and that is what the database stores.
    const inputHostname = `shop-${suffix}.b${String.fromCodePoint(0xfc)}cher.de`;
    const expectedHostname = `shop-${suffix}.xn--bcher-kva.de`;
    const expectedUnicode = `shop-${suffix}.b${String.fromCodePoint(0xfc)}cher.de`;

    const response = await create({
      aiSystemId: systemId,
      hostname: inputHostname,
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const { deployment } = (await response.json()) as DeploymentBody;
    expect(Object.keys(deployment).sort()).toEqual([
      "aiSystemId",
      "aiSystemStatus",
      "createdAt",
      "hostname",
      "id",
      "status",
      "unicodeHostname",
      "updatedAt",
    ]);
    expect(deployment).toMatchObject({
      aiSystemId: systemId,
      aiSystemStatus: "active",
      hostname: expectedHostname,
      unicodeHostname: expectedUnicode,
      status: "active",
    });

    const read = await get(deployment.id);
    expect(await read.json()).toEqual({ deployment });
  });

  it("lists by status, and by aiSystemId", async () => {
    actAs(member, memberClient);
    const systemId = await makeSystem();
    const otherSystemId = await makeSystem();

    const active = (await (
      await create({
        aiSystemId: systemId,
        hostname: hostname("listed-active"),
      })
    ).json()) as DeploymentBody;
    const toArchive = (await (
      await create({
        aiSystemId: systemId,
        hostname: hostname("listed-archived"),
      })
    ).json()) as DeploymentBody;
    await patch(toArchive.deployment.id, { status: "archived" });
    const otherSystem = (await (
      await create({
        aiSystemId: otherSystemId,
        hostname: hostname("listed-other-system"),
      })
    ).json()) as DeploymentBody;

    async function idsFor(query: string) {
      const response = await list(query);
      expect(response.status).toBe(200);
      const { deployments } = (await response.json()) as {
        deployments: { id: string }[];
      };
      return deployments.map(({ id }) => id);
    }

    const whole = (await (await list("?status=all")).json()) as {
      truncated: boolean;
    };
    expect(whole.truncated).toBe(false);

    const byDefault = await idsFor("");
    const archived = await idsFor("?status=archived");
    const all = await idsFor("?status=all");
    const bySystem = await idsFor(`?aiSystemId=${systemId}&status=all`);

    expect(byDefault).toContain(active.deployment.id);
    expect(byDefault).not.toContain(toArchive.deployment.id);
    expect(archived).toEqual(expect.arrayContaining([toArchive.deployment.id]));
    expect(archived).not.toContain(active.deployment.id);
    expect(all).toEqual(
      expect.arrayContaining([
        active.deployment.id,
        toArchive.deployment.id,
        otherSystem.deployment.id,
      ]),
    );
    expect(bySystem).toEqual(
      expect.arrayContaining([active.deployment.id, toArchive.deployment.id]),
    );
    expect(bySystem).not.toContain(otherSystem.deployment.id);
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

  it("archives and restores, and the database audits each, without the hostname", async () => {
    actAs(member, memberClient);
    const systemId = await makeSystem();
    const host = hostname("lifecycle");
    const created = (await (
      await create({ aiSystemId: systemId, hostname: host })
    ).json()) as DeploymentBody;
    const id = created.deployment.id;

    const archived = await patch(id, { status: "archived" });
    expect(archived.status).toBe(200);
    expect(((await archived.json()) as DeploymentBody).deployment.status).toBe(
      "archived",
    );

    const restored = await patch(id, { status: "active" });
    expect(restored.status).toBe(200);
    expect(((await restored.json()) as DeploymentBody).deployment.status).toBe(
      "active",
    );

    const { data: events } = await fixtures.admin
      .from("audit_events")
      .select("actor_user_id, event_type, metadata")
      .eq("entity_id", id)
      .order("created_at");
    expect(events).toEqual([
      {
        actor_user_id: member.id,
        event_type: "deployment.created",
        metadata: {},
      },
      {
        actor_user_id: member.id,
        event_type: "deployment.archived",
        metadata: {},
      },
      {
        actor_user_id: member.id,
        event_type: "deployment.unarchived",
        metadata: {},
      },
    ]);
    expect(JSON.stringify(events)).not.toContain(host);
  });
});

describe("duplicate hostnames", () => {
  it("a second active deployment of the same system at the same hostname is 409 deployment_exists", async () => {
    actAs(member, memberClient);
    const systemId = await makeSystem();
    const host = hostname("duplicate");

    const first = await create({ aiSystemId: systemId, hostname: host });
    expect(first.status).toBe(201);

    const clash = await create({ aiSystemId: systemId, hostname: host });
    expect(clash.status).toBe(409);
    expect((await readError(clash)).code).toBe("deployment_exists");
  });

  it("the same hostname on a different system is fine", async () => {
    actAs(member, memberClient);
    const systemId = await makeSystem();
    const otherSystemId = await makeSystem();
    const host = hostname("shared-hostname");

    const first = await create({ aiSystemId: systemId, hostname: host });
    expect(first.status).toBe(201);

    const second = await create({ aiSystemId: otherSystemId, hostname: host });
    expect(second.status).toBe(201);
  });

  it("restoring into a clash with another active deployment is 409 deployment_exists", async () => {
    actAs(member, memberClient);
    const systemId = await makeSystem();
    const host = hostname("restore-clash");

    const first = (await (
      await create({ aiSystemId: systemId, hostname: host })
    ).json()) as DeploymentBody;
    await patch(first.deployment.id, { status: "archived" });

    // The hostname is free again while the first is archived.
    const second = await create({ aiSystemId: systemId, hostname: host });
    expect(second.status).toBe(201);

    const restore = await patch(first.deployment.id, { status: "active" });
    expect(restore.status).toBe(409);
    expect((await readError(restore)).code).toBe("deployment_exists");
  });

  it("concurrent duplicate creations: one 201, the rest 409, never a 500", async () => {
    actAs(member, memberClient);
    const systemId = await makeSystem();
    const host = hostname("race");

    const statuses = (
      await Promise.all(
        Array.from({ length: 5 }, () =>
          create({ aiSystemId: systemId, hostname: host }),
        ),
      )
    )
      .map((response) => response.status)
      .sort();

    expect(statuses).toEqual([201, 409, 409, 409, 409]);
  });
});

describe("an archived AI system", () => {
  it("refuses a new deployment, shows on an existing one, and refuses restoring one", async () => {
    actAs(member, memberClient);
    const systemId = await makeSystem();
    const beforeArchiveHost = hostname("pre-archive");
    const existing = (await (
      await create({ aiSystemId: systemId, hostname: beforeArchiveHost })
    ).json()) as DeploymentBody;

    await archiveSystem(systemId);

    // A new deployment under the now-archived system is refused.
    actAs(member, memberClient);
    const blocked = await create({
      aiSystemId: systemId,
      hostname: hostname("post-archive"),
    });
    expect(blocked.status).toBe(409);
    expect((await readError(blocked)).code).toBe("ai_system_archived");

    // The existing deployment now reports the system's status.
    const read = await get(existing.deployment.id);
    expect(
      ((await read.json()) as DeploymentBody).deployment.aiSystemStatus,
    ).toBe("archived");

    // Archiving the deployment itself still works (no active-system check
    // on archiving, only on restoring).
    const archived = await patch(existing.deployment.id, {
      status: "archived",
    });
    expect(archived.status).toBe(200);

    // Restoring it under the archived system is refused.
    const restore = await patch(existing.deployment.id, { status: "active" });
    expect(restore.status).toBe(409);
    expect((await readError(restore)).code).toBe("ai_system_archived");
  });
});
