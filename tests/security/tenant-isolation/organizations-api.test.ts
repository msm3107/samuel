import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The organization routes' refusals, with the session and the database
 * faked (TASK-007). The real-database suites prove the tenant boundary; this
 * one proves what happens before and around it: the cross-site check, the
 * route order, the error format, and that nothing internal reaches a client.
 * Runs in `pnpm test` and `pnpm test:security`, with no Supabase.
 *
 * State lives in hoisted objects rather than `vi.fn(impl)`: `restoreMocks`
 * strips a mock's implementation between tests.
 */
const state = vi.hoisted(() => ({
  session: "valid" as "valid" | "missing" | "lookup-failed",
  sessionCalls: 0,
  rpcCalls: [] as Array<{ name: string; args: unknown }>,
  rpcResult: { data: null, error: null } as {
    data: unknown;
    error: { code: string; message: string } | null;
  },
  logs: [] as Array<{ level: string; entry: unknown }>,
}));

vi.mock("@/lib/auth/require-session", async () => {
  const { AuthenticationError, SessionLookupError } =
    await import("@/lib/auth/errors");
  return {
    requireSession: async () => {
      state.sessionCalls += 1;
      if (state.session === "missing") {
        throw new AuthenticationError("session_missing");
      }
      if (state.session === "lookup-failed") {
        throw new SessionLookupError();
      }
      return { userId: "5b0e8d1a-2c4f-4e6a-9b8c-7d1e2f3a4b5c" };
    },
  };
});

vi.mock("@/lib/database/session-client", () => ({
  createResolvingSessionClient: async () => ({
    supabase: {
      rpc: async (name: string, args: unknown) => {
        state.rpcCalls.push({ name, args });
        return state.rpcResult;
      },
    },
    applyHeldRemovals: () => {},
  }),
}));

vi.mock("@/lib/logging/logger", () => ({
  logger: {
    info: (entry: unknown) => state.logs.push({ level: "info", entry }),
    warn: (entry: unknown) => state.logs.push({ level: "warn", entry }),
    error: (entry: unknown) => state.logs.push({ level: "error", entry }),
  },
}));

import { PATCH } from "@/app/api/organizations/[organizationId]/route";
import { POST } from "@/app/api/organizations/route";
import { MAX_JSON_BODY_BYTES } from "@/lib/http/api";
import {
  apiRequest,
  readError,
  routeContext,
} from "@/tests/security/tenant-isolation/support/api-requests";

const CREATED = {
  id: "0f6b2a4c-8d1e-4f3a-9b5c-6e7d8a9b0c1d",
  name: "Acme",
  slug: "acme",
};

function create(options: Parameters<typeof apiRequest>[2] = {}) {
  return POST(
    apiRequest("POST", "/api/organizations", {
      body: { name: "Acme" },
      ...options,
    }),
  );
}

afterEach(() => {
  state.session = "valid";
  state.sessionCalls = 0;
  state.rpcCalls = [];
  state.rpcResult = { data: null, error: null };
  state.logs = [];
});

describe("cross-site requests", () => {
  it.each([
    ["no Origin", null],
    ["another site's Origin", "https://attacker.example"],
    ["a sibling subdomain's Origin", "http://evil.localhost:3000"],
    ["the right host on another scheme", "https://localhost:3000"],
  ])(
    "refuses a creation with %s before any session lookup",
    async (_label, origin) => {
      const response = await create({ origin });

      expect(response.status).toBe(403);
      expect((await readError(response)).code).toBe(
        "cross_origin_request_refused",
      );
      expect(state.sessionCalls).toBe(0);
      expect(state.rpcCalls).toEqual([]);
    },
  );

  it("refuses a cross-site rename before any session lookup", async () => {
    const response = await PATCH(
      apiRequest("PATCH", `/api/organizations/${CREATED.id}`, {
        body: { name: "Renamed" },
        origin: "https://attacker.example",
      }),
      routeContext(CREATED.id),
    );

    expect(response.status).toBe(403);
    expect(state.sessionCalls).toBe(0);
  });
});

describe("route order: authenticate, then validate, then execute", () => {
  it("refuses an unauthenticated creation with 401, before reading the body", async () => {
    state.session = "missing";

    const response = await create({ rawBody: "{not json" });

    expect(response.status).toBe(401);
    expect((await readError(response)).code).toBe("authentication_required");
    expect(state.rpcCalls).toEqual([]);
  });

  it("answers 503, not 401, when the session cannot be verified", async () => {
    state.session = "lookup-failed";

    const response = await create();

    expect(response.status).toBe(503);
    expect((await readError(response)).code).toBe("service_unavailable");
    expect(state.rpcCalls).toEqual([]);
  });

  it.each([
    ["a form body", "application/x-www-form-urlencoded", 415],
    ["plain text", "text/plain", 415],
    ["no content type", null, 415],
  ])("refuses %s", async (_label, contentType, status) => {
    const response = await create({ contentType });

    expect(response.status).toBe(status);
    expect((await readError(response)).code).toBe("unsupported_media_type");
    expect(state.rpcCalls).toEqual([]);
  });

  it("accepts a JSON content type with a charset", async () => {
    state.rpcResult = { data: CREATED, error: null };

    const response = await create({
      contentType: "application/json; charset=utf-8",
    });

    expect(response.status).toBe(201);
  });

  it("refuses a body over the limit without parsing it", async () => {
    const response = await create({
      rawBody: JSON.stringify({ name: "x".repeat(MAX_JSON_BODY_BYTES) }),
    });

    expect(response.status).toBe(413);
    expect((await readError(response)).code).toBe("request_too_large");
    expect(state.rpcCalls).toEqual([]);
  });

  it.each([
    ["malformed JSON", "{not json", "invalid_json"],
    ["a JSON array", "[]", "invalid_request"],
    ["no name", "{}", "invalid_request"],
    ["an empty name", '{"name":"   "}', "invalid_request"],
    [
      "a name over 120 characters",
      `{"name":"${"x".repeat(121)}"}`,
      "invalid_request",
    ],
    ["a name with a line break", '{"name":"Line\\nbreak"}', "invalid_request"],
    ["a name that is not a string", '{"name":42}', "invalid_request"],
  ])("refuses %s with 400", async (_label, rawBody, code) => {
    const response = await create({ rawBody });

    expect(response.status).toBe(400);
    expect((await readError(response)).code).toBe(code);
    expect(state.rpcCalls).toEqual([]);
  });

  it("sends the database the trimmed name and nothing else", async () => {
    state.rpcResult = { data: CREATED, error: null };

    await create({ body: { name: "  Acme  " } });

    expect(state.rpcCalls).toEqual([
      { name: "create_organization", args: { p_name: "Acme" } },
    ]);
  });
});

describe("what reaches the client", () => {
  it("sends id, name and slug only, whatever else the database returns", async () => {
    state.rpcResult = {
      data: {
        ...CREATED,
        created_at: "2026-09-21T00:00:00Z",
        deleted_at: null,
        owner_user_id: "5b0e8d1a-2c4f-4e6a-9b8c-7d1e2f3a4b5c",
      },
      error: null,
    };

    const response = await create();

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ organization: CREATED });
  });

  it("maps the database's hourly cap to 429", async () => {
    state.rpcResult = {
      data: null,
      error: { code: "PT429", message: "organization creation limit reached" },
    };

    const response = await create();

    expect(response.status).toBe(429);
    expect((await readError(response)).code).toBe("organization_limit_reached");
  });

  it("turns a database failure into a 500 with a reference, and no SQL, hostname or message", async () => {
    const leaky =
      'insert or update on table "memberships" violates foreign key constraint at db.internal.example:5432';
    state.rpcResult = {
      data: null,
      error: { code: "23503", message: leaky },
    };

    const response = await create();

    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain("memberships");
    expect(text).not.toContain("db.internal");
    expect(text).not.toContain("23503");
    const { error } = JSON.parse(text) as {
      error: { code: string; reference: string };
    };
    expect(error.code).toBe("internal_error");

    // The log ties the reference to the SQLSTATE, still without the message.
    const logged = state.logs.find(({ level }) => level === "error");
    expect(logged?.entry).toMatchObject({
      reference: error.reference,
      databaseCode: "23503",
      errorName: "OrganizationCreationError",
    });
    expect(JSON.stringify(state.logs)).not.toContain("db.internal");
  });

  it("refuses to pass on a database answer that is not an organization", async () => {
    state.rpcResult = { data: { id: "not-a-uuid" }, error: null };

    const response = await create();

    expect(response.status).toBe(500);
    expect((await readError(response)).code).toBe("internal_error");
  });

  it("never lets a response be cached", async () => {
    state.session = "missing";
    const refused = await create();
    state.session = "valid";
    state.rpcResult = { data: CREATED, error: null };
    const created = await create();

    expect(refused.headers.get("cache-control")).toBe("private, no-store");
    expect(created.headers.get("cache-control")).toBe("private, no-store");
  });
});
