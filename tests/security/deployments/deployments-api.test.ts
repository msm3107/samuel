import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The deployment routes' refusals and scoping, with the session and database
 * faked (TASK-013). The real-database suites prove the tenant boundary; this
 * one proves, without Supabase, that every query is filtered by the
 * authorized organization, that refusals happen before any work, that a
 * refused hostname never reaches a query or a log, and that database errors
 * map to the documented codes. Runs in `pnpm test` and `pnpm test:security`.
 *
 * State lives in hoisted objects: `restoreMocks` strips `vi.fn` bodies.
 */
const USER = "5b0e8d1a-2c4f-4e6a-9b8c-7d1e2f3a4b5c";
const ORG = "0f6b2a4c-8d1e-4f3a-9b5c-6e7d8a9b0c1d";
const SYSTEM = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const DEPLOYMENT = "1a2b3c4d-5e6f-4a3b-8c2d-1e0f9a8b7c6d";

const state = vi.hoisted(() => ({
  signedIn: true,
  role: "member" as string | null,
  queries: [] as Array<{
    table: string;
    operation: string;
    filters: Array<[string, unknown]>;
    payload?: unknown;
  }>,
  deploymentsResult: { data: null, error: null } as {
    data: unknown;
    error: { code: string; message: string; hint?: string | null } | null;
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
      : state.deploymentsResult;
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

import { HOSTNAME_ERROR_CODES } from "@/features/deployments/deployment";
import {
  GET as getDeployment,
  PATCH as patchDeployment,
} from "@/app/api/organizations/[organizationId]/deployments/[deploymentId]/route";
import {
  GET as listDeployments,
  POST as createDeployment,
} from "@/app/api/organizations/[organizationId]/deployments/route";
import {
  apiRequest,
  readError,
} from "@/tests/security/tenant-isolation/support/api-requests";

const ROW = {
  id: DEPLOYMENT,
  public_id: "dep_abcdefghijklmnopqrstuvwxyz",
  ai_system_id: SYSTEM,
  hostname: "shop.example.com",
  status: "active",
  created_at: "2026-09-22T10:00:00.123456+00:00",
  updated_at: "2026-09-22T10:00:00.123456+00:00",
  ai_system: { status: "active" },
};

function collectionContext() {
  return { params: Promise.resolve({ organizationId: ORG }) };
}

function itemContext(deploymentId = DEPLOYMENT) {
  return { params: Promise.resolve({ organizationId: ORG, deploymentId }) };
}

function create(options: Parameters<typeof apiRequest>[2] = {}) {
  return createDeployment(
    apiRequest("POST", `/api/organizations/${ORG}/deployments`, {
      body: { aiSystemId: SYSTEM, hostname: "shop.example.com" },
      ...options,
    }),
    collectionContext(),
  );
}

function patch(
  deploymentId = DEPLOYMENT,
  options: Parameters<typeof apiRequest>[2] = {},
) {
  return patchDeployment(
    apiRequest(
      "PATCH",
      `/api/organizations/${ORG}/deployments/${deploymentId}`,
      { body: { status: "archived" }, ...options },
    ),
    itemContext(deploymentId),
  );
}

function deploymentQueries() {
  return state.queries.filter(({ table }) => table === "deployments");
}

afterEach(() => {
  state.signedIn = true;
  state.role = "member";
  state.queries = [];
  state.deploymentsResult = { data: null, error: null };
  state.logs = [];
});

describe("every query is scoped to the authorized organization", () => {
  it("a list filters by organization, status unless all, and optionally aiSystemId", async () => {
    state.deploymentsResult = { data: [ROW], error: null };

    await listDeployments(
      apiRequest("GET", `/api/organizations/${ORG}/deployments`),
      collectionContext(),
    );
    await listDeployments(
      apiRequest("GET", `/api/organizations/${ORG}/deployments?status=all`),
      collectionContext(),
    );
    await listDeployments(
      apiRequest(
        "GET",
        `/api/organizations/${ORG}/deployments?aiSystemId=${SYSTEM}`,
      ),
      collectionContext(),
    );

    const [defaultList, allList, bySystem] = deploymentQueries();
    expect(defaultList?.filters).toEqual([
      ["organization_id", ORG],
      ["status", "active"],
    ]);
    expect(allList?.filters).toEqual([["organization_id", ORG]]);
    expect(bySystem?.filters).toEqual([
      ["organization_id", ORG],
      ["status", "active"],
      ["ai_system_id", SYSTEM],
    ]);
  });

  it("a read and an update filter by organization and ID, never by ID alone", async () => {
    state.deploymentsResult = { data: ROW, error: null };

    await getDeployment(
      apiRequest("GET", `/api/organizations/${ORG}/deployments/${DEPLOYMENT}`),
      itemContext(),
    );
    await patch();

    expect(deploymentQueries()).toHaveLength(2);
    for (const query of deploymentQueries()) {
      expect(query.filters).toEqual([
        ["organization_id", ORG],
        ["id", DEPLOYMENT],
      ]);
    }
  });

  it("a creation writes the authorized organization and only the given fields", async () => {
    state.deploymentsResult = { data: ROW, error: null };

    const response = await create();

    expect(response.status).toBe(201);
    expect(deploymentQueries()[0]?.payload).toEqual({
      organization_id: ORG,
      ai_system_id: SYSTEM,
      hostname: "shop.example.com",
    });
  });

  it("an update writes only the status", async () => {
    state.deploymentsResult = { data: ROW, error: null };

    await patch();

    expect(deploymentQueries()[0]?.payload).toEqual({ status: "archived" });
  });

  it("stores the normalized hostname, not what was typed", async () => {
    state.deploymentsResult = { data: ROW, error: null };

    const response = await create({
      body: {
        aiSystemId: SYSTEM,
        hostname: "HTTPS://Shop.Example.com./",
      },
    });

    expect(response.status).toBe(201);
    expect(deploymentQueries()[0]?.payload).toMatchObject({
      hostname: "shop.example.com",
    });
  });
});

describe("refusals come before any deployments query", () => {
  it("a cross-site creation, before the session", async () => {
    state.signedIn = false;

    const response = await create({ origin: "https://attacker.example" });

    expect(response.status).toBe(403);
    expect((await readError(response)).code).toBe(
      "cross_origin_request_refused",
    );
    expect(deploymentQueries()).toEqual([]);
  });

  it("a cross-site archive, before the session", async () => {
    state.signedIn = false;

    const response = await patch(DEPLOYMENT, {
      origin: "https://attacker.example",
    });

    expect(response.status).toBe(403);
    expect((await readError(response)).code).toBe(
      "cross_origin_request_refused",
    );
    expect(deploymentQueries()).toEqual([]);
  });

  it("an unauthenticated list: 401, no query", async () => {
    state.signedIn = false;

    const response = await listDeployments(
      apiRequest("GET", `/api/organizations/${ORG}/deployments`),
      collectionContext(),
    );

    expect(response.status).toBe(401);
    expect(deploymentQueries()).toEqual([]);
  });

  it("an unauthenticated creation: 401, no query", async () => {
    state.signedIn = false;

    const response = await create();

    expect(response.status).toBe(401);
    expect(deploymentQueries()).toEqual([]);
  });

  it("a non-member: 403 with the organization code, before any query", async () => {
    state.role = null;

    const response = await create();

    expect(response.status).toBe(403);
    expect((await readError(response)).code).toBe("organization_access_denied");
    expect(deploymentQueries()).toEqual([]);
  });

  it("a viewer lists and reads, but cannot create or archive: 403, no query made for the write", async () => {
    state.role = "viewer";
    state.deploymentsResult = { data: [ROW], error: null };

    const listed = await listDeployments(
      apiRequest("GET", `/api/organizations/${ORG}/deployments`),
      collectionContext(),
    );
    expect(listed.status).toBe(200);

    state.deploymentsResult = { data: ROW, error: null };
    const read = await getDeployment(
      apiRequest("GET", `/api/organizations/${ORG}/deployments/${DEPLOYMENT}`),
      itemContext(),
    );
    expect(read.status).toBe(200);

    state.queries = [];
    const created = await create();
    const patched = await patch();

    expect(created.status).toBe(403);
    expect(patched.status).toBe(403);
    expect(deploymentQueries()).toEqual([]);
  });

  it("a deployment ID that is not a UUID: 404, with no query made", async () => {
    const getResponse = await getDeployment(
      apiRequest("GET", `/api/organizations/${ORG}/deployments/not-a-uuid`),
      itemContext("not-a-uuid"),
    );
    const patchResponse = await patch("not-a-uuid");

    expect(getResponse.status).toBe(404);
    expect((await readError(getResponse)).code).toBe("deployment_not_found");
    expect(patchResponse.status).toBe(404);
    expect((await readError(patchResponse)).code).toBe("deployment_not_found");
    expect(deploymentQueries()).toEqual([]);
  });

  it("a repeated ?status: 400, no query made", async () => {
    const response = await listDeployments(
      apiRequest(
        "GET",
        `/api/organizations/${ORG}/deployments?status=active&status=archived`,
      ),
      collectionContext(),
    );

    expect(response.status).toBe(400);
    expect((await readError(response)).code).toBe("invalid_request");
    expect(deploymentQueries()).toEqual([]);
  });

  it.each([
    ["organizationId", () => ORG],
    ["id", () => DEPLOYMENT],
    ["status", () => "active"],
  ])(
    "a creation carrying %s: 400, and nothing is inserted",
    async (field, value) => {
      const response = await create({
        body: {
          aiSystemId: SYSTEM,
          hostname: "shop.example.com",
          [field]: value(),
        },
      });

      expect(response.status).toBe(400);
      expect((await readError(response)).code).toBe("invalid_request");
      expect(deploymentQueries()).toEqual([]);
    },
  );
});

describe("hostnames the verifier would never reach (TASK-012 boundary)", () => {
  const EXITS: Array<[string, keyof typeof HOSTNAME_ERROR_CODES]> = [
    ["localhost", "PRIVATE_NETWORK_BLOCKED"],
    ["127.0.0.1", "PRIVATE_NETWORK_BLOCKED"],
    ["169.254.169.254", "PRIVATE_NETWORK_BLOCKED"],
    ["[::1]", "PRIVATE_NETWORK_BLOCKED"],
    ["[fd00::1]", "PRIVATE_NETWORK_BLOCKED"],
    ["https://user:pass@shop.example.com", "EMBEDDED_CREDENTIALS"],
    ["ftp://shop.example.com", "UNSUPPORTED_SCHEME"],
    ["https://shop.example.com/chat", "PATH_NOT_ALLOWED"],
    ["shop.example.com:8443", "PORT_NOT_ALLOWED"],
  ];

  it.each(EXITS)(
    "%s is refused with the mapped code, and nothing is inserted",
    async (hostname, failureCode) => {
      const response = await create({ body: { aiSystemId: SYSTEM, hostname } });

      expect(response.status).toBe(400);
      expect((await readError(response)).code).toBe(
        HOSTNAME_ERROR_CODES[failureCode],
      );
      expect(deploymentQueries()).toEqual([]);
    },
  );

  it("the refused hostname never appears in the response body", async () => {
    const response = await create({
      body: { aiSystemId: SYSTEM, hostname: "127.0.0.1" },
    });

    const text = await response.text();
    expect(text).not.toContain("127.0.0.1");
    expect(JSON.parse(text)).toEqual({
      error: {
        code: expect.any(String) as string,
        reference: expect.any(String) as string,
      },
    });
  });

  it("the refused hostname never appears in the logs", async () => {
    await create({ body: { aiSystemId: SYSTEM, hostname: "169.254.169.254" } });

    const serialized = JSON.stringify(state.logs);
    expect(serialized).not.toContain("169.254.169.254");
  });
});

describe("what a database refusal becomes", () => {
  it("a unique violation is 409 deployment_exists", async () => {
    state.deploymentsResult = {
      data: null,
      error: { code: "23505", message: "duplicate key" },
    };

    const response = await create();

    expect(response.status).toBe(409);
    expect((await readError(response)).code).toBe("deployment_exists");
  });

  it("the archived-AI-system check is 409 ai_system_archived", async () => {
    state.deploymentsResult = {
      data: null,
      error: {
        code: "23514",
        message: "a deployment's AI system is archived",
        hint: "ai_system_archived",
      },
    };

    const response = await create();

    expect(response.status).toBe(409);
    expect((await readError(response)).code).toBe("ai_system_archived");
  });

  it("is recognized by its hint, not its message (PR #27 review, note 2)", async () => {
    state.deploymentsResult = {
      data: null,
      error: { code: "23514", message: "reworded", hint: "ai_system_archived" },
    };
    const reworded = await create();
    state.deploymentsResult = {
      data: null,
      error: {
        code: "23514",
        message: "a deployment's AI system is archived",
        hint: null,
      },
    };
    const noHint = await create();

    expect(reworded.status).toBe(409);
    expect(noHint.status).toBe(500);
  });

  it("any other check violation is a 500, not mistaken for the archived-system one", async () => {
    state.deploymentsResult = {
      data: null,
      error: { code: "23514", message: "new row violates check constraint" },
    };

    const response = await create();

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("check constraint");
    expect(JSON.parse(text).error.code).toBe("internal_error");
  });

  it("the composite foreign key is 404 ai_system_not_found, on create only", async () => {
    state.deploymentsResult = {
      data: null,
      error: { code: "23503", message: "foreign key violation" },
    };

    const response = await create();

    expect(response.status).toBe(404);
    expect((await readError(response)).code).toBe("ai_system_not_found");
  });

  it("a row-level security refusal is 403, not 500", async () => {
    state.deploymentsResult = {
      data: null,
      error: { code: "42501", message: "new row violates row-level security" },
    };

    const created = await create();
    expect(created.status).toBe(403);

    state.deploymentsResult = {
      data: null,
      error: { code: "42501", message: "new row violates row-level security" },
    };
    const patched = await patch();
    expect(patched.status).toBe(403);
  });
});
