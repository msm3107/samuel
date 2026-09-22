import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The AI system routes' refusals and scoping, with the session and database
 * faked (TASK-009). The real-database suites prove the tenant boundary; this
 * one proves, without Supabase, that every query is filtered by the
 * authorized organization, that refusals happen before any work, and that
 * nothing internal reaches a client. Runs in `pnpm test` and
 * `pnpm test:security`.
 *
 * State lives in hoisted objects: `restoreMocks` strips `vi.fn` bodies.
 */
const USER = "5b0e8d1a-2c4f-4e6a-9b8c-7d1e2f3a4b5c";
const ORG = "0f6b2a4c-8d1e-4f3a-9b5c-6e7d8a9b0c1d";
const SYSTEM = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

const state = vi.hoisted(() => ({
  signedIn: true,
  role: "member" as string | null,
  queries: [] as Array<{
    table: string;
    operation: string;
    filters: Array<[string, unknown]>;
    payload?: unknown;
  }>,
  aiSystemsResult: { data: null, error: null } as {
    data: unknown;
    error: { code: string; message: string } | null;
  },
  logs: [] as unknown[],
}));

vi.mock("@/lib/auth/require-session", async () => {
  const { AuthenticationError } = await import("@/lib/auth/errors");
  return {
    requireSession: async () => {
      if (!state.signedIn) {
        throw new AuthenticationError("session_missing");
      }
      return { userId: USER };
    },
  };
});

/** A chainable stand-in for the few PostgREST calls the code makes. */
function fakeQuery(table: string) {
  const record: (typeof state.queries)[number] = {
    table,
    operation: "select",
    filters: [],
  };
  state.queries.push(record);
  const result = () =>
    table === "memberships"
      ? {
          data: state.role === null ? null : { role: state.role },
          error: null,
        }
      : state.aiSystemsResult;
  const builder = {
    select: () => builder,
    insert: (payload: unknown) => {
      record.operation = "insert";
      record.payload = payload;
      return builder;
    },
    update: (payload: unknown) => {
      record.operation = "update";
      record.payload = payload;
      return builder;
    },
    eq: (column: string, value: unknown) => {
      record.filters.push([column, value]);
      return builder;
    },
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => result(),
    single: async () => result(),
    then: (resolve: (value: unknown) => void) => resolve(result()),
  };
  return builder;
}

vi.mock("@/lib/database/session-client", () => ({
  createResolvingSessionClient: async () => ({
    supabase: { from: (table: string) => fakeQuery(table) },
    applyHeldRemovals: () => {},
  }),
}));

vi.mock("@/lib/logging/logger", () => ({
  logger: {
    info: (entry: unknown) => state.logs.push(entry),
    warn: (entry: unknown) => state.logs.push(entry),
    error: (entry: unknown) => state.logs.push(entry),
  },
}));

import {
  GET as getSystem,
  PATCH as patchSystem,
} from "@/app/api/organizations/[organizationId]/ai-systems/[systemId]/route";
import {
  GET as listSystems,
  POST as createSystem,
} from "@/app/api/organizations/[organizationId]/ai-systems/route";
import {
  apiRequest,
  readError,
} from "@/tests/security/tenant-isolation/support/api-requests";

const ROW = {
  id: SYSTEM,
  name: "Support Bot",
  description: null,
  system_type: "chatbot",
  provider: null,
  status: "active",
  updated_at: "2026-09-21T10:00:00.123456+00:00",
};

function collectionContext() {
  return { params: Promise.resolve({ organizationId: ORG }) };
}

function itemContext(systemId = SYSTEM) {
  return { params: Promise.resolve({ organizationId: ORG, systemId }) };
}

function create(options: Parameters<typeof apiRequest>[2] = {}) {
  return createSystem(
    apiRequest("POST", `/api/organizations/${ORG}/ai-systems`, {
      body: { name: "Support Bot", systemType: "chatbot" },
      ...options,
    }),
    collectionContext(),
  );
}

function aiSystemQueries() {
  return state.queries.filter(({ table }) => table === "ai_systems");
}

afterEach(() => {
  state.signedIn = true;
  state.role = "member";
  state.queries = [];
  state.aiSystemsResult = { data: null, error: null };
  state.logs = [];
});

describe("every query is scoped to the authorized organization", () => {
  it("a list filters by organization, and by status unless all", async () => {
    state.aiSystemsResult = { data: [ROW], error: null };

    await listSystems(
      apiRequest("GET", `/api/organizations/${ORG}/ai-systems`),
      collectionContext(),
    );
    await listSystems(
      apiRequest("GET", `/api/organizations/${ORG}/ai-systems?status=all`),
      collectionContext(),
    );

    const [defaultList, allList] = aiSystemQueries();
    expect(defaultList?.filters).toEqual([
      ["organization_id", ORG],
      ["status", "active"],
    ]);
    expect(allList?.filters).toEqual([["organization_id", ORG]]);
  });

  it("a read and an edit filter by organization and ID, never by ID alone", async () => {
    state.aiSystemsResult = { data: ROW, error: null };

    await getSystem(
      apiRequest("GET", `/api/organizations/${ORG}/ai-systems/${SYSTEM}`),
      itemContext(),
    );
    await patchSystem(
      apiRequest("PATCH", `/api/organizations/${ORG}/ai-systems/${SYSTEM}`, {
        body: { status: "archived" },
      }),
      itemContext(),
    );

    expect(aiSystemQueries()).toHaveLength(2);
    for (const query of aiSystemQueries()) {
      expect(query.filters).toEqual([
        ["organization_id", ORG],
        ["id", SYSTEM],
      ]);
    }
  });

  it("a creation writes the authorized organization and only the given fields", async () => {
    state.aiSystemsResult = { data: ROW, error: null };

    const response = await create({
      body: {
        name: "  Support Bot ",
        systemType: "chatbot",
        provider: "OpenAI",
      },
    });

    expect(response.status).toBe(201);
    expect(aiSystemQueries()[0]?.payload).toEqual({
      organization_id: ORG,
      name: "Support Bot",
      system_type: "chatbot",
      description: null,
      provider: "OpenAI",
    });
  });

  it("an edit writes only the fields the change names", async () => {
    state.aiSystemsResult = { data: ROW, error: null };

    await patchSystem(
      apiRequest("PATCH", `/api/organizations/${ORG}/ai-systems/${SYSTEM}`, {
        body: { provider: null },
      }),
      itemContext(),
    );

    expect(aiSystemQueries()[0]?.payload).toEqual({ provider: null });
  });
});

describe("refusals come before any AI system query", () => {
  it("a cross-site creation, before the session", async () => {
    state.signedIn = false;

    const response = await create({ origin: "https://attacker.example" });

    expect(response.status).toBe(403);
    expect((await readError(response)).code).toBe(
      "cross_origin_request_refused",
    );
    expect(state.queries).toEqual([]);
  });

  it("an unauthenticated list: 401", async () => {
    state.signedIn = false;

    const response = await listSystems(
      apiRequest("GET", `/api/organizations/${ORG}/ai-systems`),
      collectionContext(),
    );

    expect(response.status).toBe(401);
    expect(aiSystemQueries()).toEqual([]);
  });

  it("a non-member: 403 with the organization code", async () => {
    state.role = null;

    const response = await create();

    expect(response.status).toBe(403);
    expect((await readError(response)).code).toBe("organization_access_denied");
    expect(aiSystemQueries()).toEqual([]);
  });

  it("a viewer creating or editing: 403, even with an invalid body", async () => {
    state.role = "viewer";

    const created = await create({ rawBody: "{not json" });
    const edited = await patchSystem(
      apiRequest("PATCH", `/api/organizations/${ORG}/ai-systems/${SYSTEM}`, {
        body: { status: "archived" },
      }),
      itemContext(),
    );

    expect(created.status).toBe(403);
    expect(edited.status).toBe(403);
    expect(aiSystemQueries()).toEqual([]);
  });

  it("a system ID that is not a UUID: 404, with no query made", async () => {
    const response = await getSystem(
      apiRequest("GET", `/api/organizations/${ORG}/ai-systems/not-a-uuid`),
      itemContext("not-a-uuid"),
    );

    expect(response.status).toBe(404);
    expect((await readError(response)).code).toBe("ai_system_not_found");
    expect(aiSystemQueries()).toEqual([]);
  });

  it("an empty change: 400", async () => {
    const response = await patchSystem(
      apiRequest("PATCH", `/api/organizations/${ORG}/ai-systems/${SYSTEM}`, {
        body: {},
      }),
      itemContext(),
    );

    expect(response.status).toBe(400);
    expect(aiSystemQueries()).toEqual([]);
  });
});

describe("a list says when it was cut short (PR #23 review)", () => {
  async function listed() {
    const response = await listSystems(
      apiRequest("GET", `/api/organizations/${ORG}/ai-systems?status=all`),
      collectionContext(),
    );
    return (await response.json()) as {
      aiSystems: unknown[];
      truncated: boolean;
    };
  }

  function rows(count: number) {
    return Array.from({ length: count }, (_unused, index) => ({
      ...ROW,
      id: `9a8b7c6d-5e4f-4a3b-8c2d-${index.toString(16).padStart(12, "0")}`,
      name: `System ${index}`,
    }));
  }

  it("200 systems: all of them, not truncated", async () => {
    state.aiSystemsResult = { data: rows(200), error: null };

    const body = await listed();

    expect(body.aiSystems).toHaveLength(200);
    expect(body.truncated).toBe(false);
  });

  it("more than 200: the first 200, and truncated", async () => {
    state.aiSystemsResult = { data: rows(201), error: null };

    const body = await listed();

    expect(body.aiSystems).toHaveLength(200);
    expect(body.truncated).toBe(true);
  });
});

describe("an edit names the version it was based on (TASK-010 review)", () => {
  const VERSION = "2026-09-21T10:00:00.123456+00:00";

  function patchWith(body: unknown) {
    return patchSystem(
      apiRequest("PATCH", `/api/organizations/${ORG}/ai-systems/${SYSTEM}`, {
        body,
      }),
      itemContext(),
    );
  }

  it("the update matches that version too, and does not write it", async () => {
    state.aiSystemsResult = { data: ROW, error: null };

    const response = await patchWith({
      name: "Renamed",
      expectedUpdatedAt: VERSION,
    });

    expect(response.status).toBe(200);
    const update = aiSystemQueries().find(
      (query) => query.operation === "update",
    );
    expect(update?.filters).toContainEqual(["updated_at", VERSION]);
    expect(update?.payload).toEqual({ name: "Renamed" });
  });

  it("without a version, the update is not filtered by one", async () => {
    state.aiSystemsResult = { data: ROW, error: null };

    await patchWith({ status: "archived" });

    const update = aiSystemQueries().find(
      (query) => query.operation === "update",
    );
    expect(update?.filters.map(([column]) => column)).not.toContain(
      "updated_at",
    );
  });

  it("a version alone is not a change, and a version must be a timestamp", async () => {
    for (const body of [
      { expectedUpdatedAt: VERSION },
      { name: "Renamed", expectedUpdatedAt: "yesterday" },
      { name: "Renamed", expectedUpdatedAt: 1 },
    ]) {
      const response = await patchWith(body);
      expect(response.status).toBe(400);
      expect((await readError(response)).code).toBe("invalid_request");
    }
  });
});

describe("what reaches the client", () => {
  it("seven fields, whatever else the database returns", async () => {
    state.aiSystemsResult = {
      data: {
        ...ROW,
        organization_id: ORG,
        created_at: "2026-09-21T00:00:00Z",
      },
      error: null,
    };

    const response = await getSystem(
      apiRequest("GET", `/api/organizations/${ORG}/ai-systems/${SYSTEM}`),
      itemContext(),
    );

    expect(await response.json()).toEqual({
      aiSystem: {
        id: SYSTEM,
        name: "Support Bot",
        description: null,
        systemType: "chatbot",
        provider: null,
        status: "active",
        updatedAt: "2026-09-21T10:00:00.123456+00:00",
      },
    });
  });

  it("a unique violation becomes 409 ai_system_name_taken", async () => {
    state.aiSystemsResult = {
      data: null,
      error: {
        code: "23505",
        message: 'duplicate key "ai_systems_active_name_key"',
      },
    };

    const response = await create();

    expect(response.status).toBe(409);
    const text = await response.text();
    expect(text).not.toContain("ai_systems_active_name_key");
    expect(JSON.parse(text).error.code).toBe("ai_system_name_taken");
  });

  it("any other database refusal is a 500 with a reference and no SQL", async () => {
    state.aiSystemsResult = {
      data: null,
      error: {
        code: "23514",
        message: 'new row violates check constraint "ai_systems_name_check"',
      },
    };

    const response = await create();

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("ai_systems_name_check");
    expect(text).not.toContain("23514");
    expect(JSON.parse(text).error.code).toBe("internal_error");
  });

  it("an RLS refusal after the check (a role removed meanwhile) is a 403, not a 500", async () => {
    state.aiSystemsResult = {
      data: null,
      error: { code: "42501", message: "new row violates row-level security" },
    };

    const response = await create();

    expect(response.status).toBe(403);
  });
});
