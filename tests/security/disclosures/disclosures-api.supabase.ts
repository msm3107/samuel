import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * README §8's isolation checks for disclosures through the routes, against
 * the real local database (TASK-017): user A cannot read organization B's
 * disclosure history or publish under B's system, through either
 * organization's URL; a viewer reads but cannot publish; nothing of B's ever
 * reaches A's response. tenant-isolation/disclosures.supabase.ts (TASK-016)
 * proves the same boundary in RLS alone; this proves the routes on top of it
 * add no way around it.
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
  GET as listDisclosures,
  POST as createDisclosure,
} from "@/app/api/organizations/[organizationId]/ai-systems/[systemId]/disclosures/route";
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

let userB: TestUser;
let clientB: SupabaseClient;
let orgB: TestOrganization;
/** Has a published version. */
let systemBWithHistory: string;
let disclosureB: string;
/** Never published: proves the 404/403 does not depend on there being history. */
let systemBWithoutHistory: string;

let viewerOfA: TestUser;
let viewerClient: SupabaseClient;

function message(label: string): string {
  return `${label} ${randomUUID().slice(0, 8)}.`;
}

const VALID_BODY = {
  message: message("Notice"),
  language: "en",
  enabled: true,
  expectedVersion: null,
};

function collection(organizationId: string, systemId: string) {
  const path = `/api/organizations/${organizationId}/ai-systems/${systemId}/disclosures`;
  return {
    path,
    context: {
      params: Promise.resolve({ organizationId, systemId }),
    },
  };
}

async function createSystemAs(
  user: TestUser,
  client: SupabaseClient,
  organizationId: string,
): Promise<string> {
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

async function publishAs(
  user: TestUser,
  client: SupabaseClient,
  organizationId: string,
  systemId: string,
  body: unknown = VALID_BODY,
) {
  actAs(user, client);
  const { path, context } = collection(organizationId, systemId);
  return createDisclosure(apiRequest("POST", path, { body }), context);
}

async function getHistoryAs(
  user: TestUser,
  client: SupabaseClient,
  organizationId: string,
  systemId: string,
) {
  actAs(user, client);
  const { path, context } = collection(organizationId, systemId);
  return listDisclosures(apiRequest("GET", path), context);
}

beforeAll(async () => {
  userA = await fixtures.createUser();
  clientA = await fixtures.signedInClient(userA);
  orgA = await fixtures.createOrganization({ ownerId: userA.id });
  systemA = await createSystemAs(userA, clientA, orgA.id);

  userB = await fixtures.createUser();
  clientB = await fixtures.signedInClient(userB);
  orgB = await fixtures.createOrganization({ ownerId: userB.id });

  systemBWithHistory = await createSystemAs(userB, clientB, orgB.id);
  const published = await publishAs(
    userB,
    clientB,
    orgB.id,
    systemBWithHistory,
    {
      message: message("B's notice"),
      language: "en",
      enabled: true,
      expectedVersion: null,
    },
  );
  const { disclosure } = (await published.json()) as {
    disclosure: { id: string };
  };
  disclosureB = disclosure.id;

  systemBWithoutHistory = await createSystemAs(userB, clientB, orgB.id);

  viewerOfA = await fixtures.createUser();
  await fixtures.addMember(orgA.id, viewerOfA.id, "viewer");
  viewerClient = await fixtures.signedInClient(viewerOfA);
}, 30_000);

afterAll(async () => {
  await fixtures.cleanup();
});

describe("user A and organization B's disclosures", () => {
  it("cannot read B's history through A's own organization: 404, whether or not B's system has any published versions", async () => {
    for (const systemId of [systemBWithHistory, systemBWithoutHistory]) {
      const response = await getHistoryAs(userA, clientA, orgA.id, systemId);
      expect(response.status).toBe(404);
      expect((await readError(response)).code).toBe("ai_system_not_found");
    }
  });

  it("cannot read B's history through B's own organization: 403, the same as for any organization A is not in", async () => {
    for (const systemId of [systemBWithHistory, systemBWithoutHistory]) {
      const response = await getHistoryAs(userA, clientA, orgB.id, systemId);
      expect(response.status).toBe(403);
      expect((await readError(response)).code).toBe(
        "organization_access_denied",
      );
    }
  });

  it("cannot publish under B's system through A's own organization: 404, whether or not B's system has history", async () => {
    for (const systemId of [systemBWithHistory, systemBWithoutHistory]) {
      const response = await publishAs(userA, clientA, orgA.id, systemId, {
        ...VALID_BODY,
        message: message("Planted"),
      });
      expect(response.status).toBe(404);
      expect((await readError(response)).code).toBe("ai_system_not_found");
    }
  });

  it("cannot publish under B's system through B's own organization: 403", async () => {
    for (const systemId of [systemBWithHistory, systemBWithoutHistory]) {
      const response = await publishAs(userA, clientA, orgB.id, systemId, {
        ...VALID_BODY,
        message: message("Planted"),
      });
      expect(response.status).toBe(403);
      expect((await readError(response)).code).toBe(
        "organization_access_denied",
      );
    }
  });

  it("nothing of B's history reaches A's response", async () => {
    const response = await getHistoryAs(userA, clientA, orgA.id, systemA);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(disclosureB);
    expect(text).not.toContain(orgB.id);
    expect(text).not.toContain(systemBWithHistory);
  });

  it("B's system does not appear if A lists its own history for its own system, and A's publish is unaffected by B's version numbering", async () => {
    const response = await publishAs(userA, clientA, orgA.id, systemA, {
      ...VALID_BODY,
      message: message("A's own notice"),
    });
    expect(response.status).toBe(201);
    const { disclosure } = (await response.json()) as {
      disclosure: { version: number };
    };
    // A's system had no versions of its own; B publishing first must not
    // have advanced A's numbering.
    expect(disclosure.version).toBe(1);
  });
});

describe("roles within organization A", () => {
  it("a viewer reads A's history but cannot publish: 403, and nothing is stored", async () => {
    const read = await getHistoryAs(viewerOfA, viewerClient, orgA.id, systemA);
    expect(read.status).toBe(200);

    const before = await getHistoryAs(userA, clientA, orgA.id, systemA);
    const beforeBody = (await before.json()) as { disclosures: unknown[] };

    const response = await publishAs(
      viewerOfA,
      viewerClient,
      orgA.id,
      systemA,
      {
        ...VALID_BODY,
        message: message("Should not land"),
      },
    );

    expect(response.status).toBe(403);
    const after = await getHistoryAs(userA, clientA, orgA.id, systemA);
    const afterBody = (await after.json()) as { disclosures: unknown[] };
    expect(afterBody.disclosures).toHaveLength(beforeBody.disclosures.length);
  });
});
