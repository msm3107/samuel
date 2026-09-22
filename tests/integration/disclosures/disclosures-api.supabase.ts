import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The disclosure routes against the real local database (TASK-017): a
 * member's whole round trip — publishing, listing history and turning the
 * notice off — and what `public.publish_disclosure` and TASK-016's triggers
 * do around it (numbering, the stale and unchanged checks, the archived-
 * system refusal, concurrent publishes, and the audit trail).
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

type Disclosure = {
  id: string;
  version: number;
  message: string;
  language: string;
  enabled: boolean;
  createdAt: string;
  createdBy: string;
};

type DisclosureBody = { disclosure: Disclosure };

type HistoryBody = {
  aiSystemStatus: string;
  disclosures: Disclosure[];
  truncated: boolean;
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

function message(label: string): string {
  return `${label} ${randomUUID().slice(0, 8)}.`;
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

function context(systemId: string) {
  return {
    params: Promise.resolve({ organizationId: organization.id, systemId }),
  };
}

async function publish(systemId: string, body: unknown) {
  return createDisclosure(
    apiRequest(
      "POST",
      `/api/organizations/${organization.id}/ai-systems/${systemId}/disclosures`,
      { body },
    ),
    context(systemId),
  );
}

async function history(systemId: string) {
  return listDisclosures(
    apiRequest(
      "GET",
      `/api/organizations/${organization.id}/ai-systems/${systemId}/disclosures`,
    ),
    context(systemId),
  );
}

describe("a member's round trip", () => {
  it("publishes v1 (expectedVersion null) and gets back the documented fields", async () => {
    actAs(member, memberClient);
    const systemId = await makeSystem();

    const response = await publish(systemId, {
      message: message("First notice"),
      language: "en",
      enabled: true,
      expectedVersion: null,
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const { disclosure } = (await response.json()) as DisclosureBody;
    expect(Object.keys(disclosure).sort()).toEqual(
      [
        "createdAt",
        "createdBy",
        "enabled",
        "id",
        "language",
        "message",
        "version",
      ].sort(),
    );
    expect(disclosure).toMatchObject({
      version: 1,
      language: "en",
      enabled: true,
      createdBy: member.id,
    });
  });

  it("lists history newest first, with the AI system's status", async () => {
    actAs(member, memberClient);
    const systemId = await makeSystem();
    const v1 = (await (
      await publish(systemId, {
        message: message("V1"),
        language: "en",
        enabled: true,
        expectedVersion: null,
      })
    ).json()) as DisclosureBody;
    const v2 = (await (
      await publish(systemId, {
        message: message("V2"),
        language: "en",
        enabled: true,
        expectedVersion: v1.disclosure.version,
      })
    ).json()) as DisclosureBody;

    const response = await history(systemId);

    expect(response.status).toBe(200);
    const body = (await response.json()) as HistoryBody;
    expect(body.aiSystemStatus).toBe("active");
    expect(body.truncated).toBe(false);
    expect(body.disclosures.map((d) => d.id)).toEqual([
      v2.disclosure.id,
      v1.disclosure.id,
    ]);
  });

  it("v2 names v1 as expectedVersion, and is accepted", async () => {
    actAs(member, memberClient);
    const systemId = await makeSystem();
    const v1 = (await (
      await publish(systemId, {
        message: message("V1"),
        language: "en",
        enabled: true,
        expectedVersion: null,
      })
    ).json()) as DisclosureBody;

    const response = await publish(systemId, {
      message: message("V2"),
      language: "en",
      enabled: true,
      expectedVersion: v1.disclosure.version,
    });

    expect(response.status).toBe(201);
    const { disclosure } = (await response.json()) as DisclosureBody;
    expect(disclosure.version).toBe(v1.disclosure.version + 1);
  });

  it("a system with no published versions is a 200 empty list", async () => {
    actAs(member, memberClient);
    const systemId = await makeSystem();

    const response = await history(systemId);

    expect(response.status).toBe(200);
    const body = (await response.json()) as HistoryBody;
    expect(body).toEqual({
      aiSystemStatus: "active",
      disclosures: [],
      truncated: false,
    });
  });

  it("enabled: false publishes a new version, not the same one turned off", async () => {
    actAs(member, memberClient);
    const systemId = await makeSystem();
    const text = message("Notice");
    const on = (await (
      await publish(systemId, {
        message: text,
        language: "en",
        enabled: true,
        expectedVersion: null,
      })
    ).json()) as DisclosureBody;

    const off = await publish(systemId, {
      message: text,
      language: "en",
      enabled: false,
      expectedVersion: on.disclosure.version,
    });

    expect(off.status).toBe(201);
    const { disclosure } = (await off.json()) as DisclosureBody;
    expect(disclosure.enabled).toBe(false);
    expect(disclosure.version).toBe(on.disclosure.version + 1);

    // The version it turned off is untouched.
    const read = await history(systemId);
    const body = (await read.json()) as HistoryBody;
    const original = body.disclosures.find((d) => d.id === on.disclosure.id);
    expect(original?.enabled).toBe(true);
  });
});

describe("a stale publish", () => {
  it("an expectedVersion that is no longer current is refused, and nothing is stored", async () => {
    actAs(member, memberClient);
    const systemId = await makeSystem();
    const v1 = (await (
      await publish(systemId, {
        message: message("V1"),
        language: "en",
        enabled: true,
        expectedVersion: null,
      })
    ).json()) as DisclosureBody;
    await publish(systemId, {
      message: message("V2"),
      language: "en",
      enabled: true,
      expectedVersion: v1.disclosure.version,
    });

    const staleMessage = message("Stale attempt");
    const stale = await publish(systemId, {
      message: staleMessage,
      language: "en",
      enabled: true,
      expectedVersion: v1.disclosure.version,
    });

    expect(stale.status).toBe(409);
    expect((await readError(stale)).code).toBe("disclosure_changed");

    const read = await history(systemId);
    const body = (await read.json()) as HistoryBody;
    expect(body.disclosures).toHaveLength(2);
    expect(body.disclosures.map((d) => d.message)).not.toContain(staleMessage);
  });
});

describe("an unchanged publish", () => {
  it("the same message, language and enabled as the current version is refused, 409 disclosure_unchanged", async () => {
    actAs(member, memberClient);
    const systemId = await makeSystem();
    const body = { message: message("Same"), language: "en", enabled: true };
    const v1 = (await (
      await publish(systemId, { ...body, expectedVersion: null })
    ).json()) as DisclosureBody;

    const again = await publish(systemId, {
      ...body,
      expectedVersion: v1.disclosure.version,
    });

    expect(again.status).toBe(409);
    expect((await readError(again)).code).toBe("disclosure_unchanged");

    const read = await history(systemId);
    const historyBody = (await read.json()) as HistoryBody;
    expect(historyBody.disclosures).toHaveLength(1);
  });
});

describe("an archived AI system", () => {
  it("refuses a publish, 409 ai_system_archived", async () => {
    actAs(member, memberClient);
    const systemId = await makeSystem();
    await archiveSystem(systemId);

    const response = await publish(systemId, {
      message: message("Blocked"),
      language: "en",
      enabled: true,
      expectedVersion: null,
    });

    expect(response.status).toBe(409);
    expect((await readError(response)).code).toBe("ai_system_archived");
  });
});

describe("a system that doesn't exist", () => {
  it.each([
    ["an unknown system id", () => randomUUID()],
    ["a non-UUID system id", () => "not-a-uuid"],
  ])(
    "publishing under %s is 404 ai_system_not_found",
    async (_label, systemId) => {
      actAs(member, memberClient);

      const response = await publish(systemId(), {
        message: message("Nowhere"),
        language: "en",
        enabled: true,
        expectedVersion: null,
      });

      expect(response.status).toBe(404);
      expect((await readError(response)).code).toBe("ai_system_not_found");
    },
  );

  it.each([
    ["an unknown system id", () => randomUUID()],
    ["a non-UUID system id", () => "not-a-uuid"],
  ])(
    "reading history for %s is 404 ai_system_not_found",
    async (_label, systemId) => {
      actAs(member, memberClient);

      const response = await history(systemId());

      expect(response.status).toBe(404);
      expect((await readError(response)).code).toBe("ai_system_not_found");
    },
  );
});

describe("concurrent publishes for one system", () => {
  it("6 at once, all with the same expectedVersion: exactly one 201, the rest 409 disclosure_changed", async () => {
    actAs(member, memberClient);
    const systemId = await makeSystem();
    const base = (await (
      await publish(systemId, {
        message: message("Base"),
        language: "en",
        enabled: true,
        expectedVersion: null,
      })
    ).json()) as DisclosureBody;

    const responses = await Promise.all(
      Array.from({ length: 6 }, (_unused, index) =>
        publish(systemId, {
          message: message(`Concurrent ${index}`),
          language: "en",
          enabled: true,
          expectedVersion: base.disclosure.version,
        }),
      ),
    );

    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);

    const refused = responses.filter((response) => response.status === 409);
    const errors = await Promise.all(
      refused.map((response) => readError(response)),
    );
    expect(errors.every((error) => error.code === "disclosure_changed")).toBe(
      true,
    );

    const read = await history(systemId);
    const body = (await read.json()) as HistoryBody;
    // The base version, plus exactly one winner.
    expect(body.disclosures).toHaveLength(2);
  });
});

describe("audit", () => {
  it("a publish writes disclosure.published, naming the publisher, with empty metadata", async () => {
    actAs(member, memberClient);
    const systemId = await makeSystem();

    const response = await publish(systemId, {
      message: message("Audited"),
      language: "en",
      enabled: true,
      expectedVersion: null,
    });
    const { disclosure } = (await response.json()) as DisclosureBody;

    const { data: events } = await fixtures.admin
      .from("audit_events")
      .select("actor_user_id, event_type, entity_type, metadata")
      .eq("entity_id", disclosure.id);

    expect(events).toEqual([
      {
        actor_user_id: member.id,
        event_type: "disclosure.published",
        entity_type: "disclosure",
        metadata: {},
      },
    ]);
  });
});
