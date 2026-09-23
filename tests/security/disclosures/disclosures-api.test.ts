import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The disclosure POST route's refusals, with the session and database faked
 * (TASK-017). The real-database suites prove the tenant boundary; this one
 * proves, without Supabase, that a cross-origin request is refused before
 * authentication, that the body is validated (content type, size, unknown
 * fields) before any publish is attempted, and that every error body carries
 * only a code and a reference. Runs in `pnpm test` and `pnpm test:security`.
 */
const USER = "5b0e8d1a-2c4f-4e6a-9b8c-7d1e2f3a4b5c";
const ORG = "0f6b2a4c-8d1e-4f3a-9b5c-6e7d8a9b0c1d";
const SYSTEM = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

const state = vi.hoisted(() => ({
  signedIn: true,
  role: "member" as string | null,
  rpcCalls: [] as Array<{ name: string; params: unknown }>,
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

vi.mock("@/lib/database/session-client", () => ({
  createResolvingSessionClient: async () => ({
    supabase: {
      from: (_table: string) => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: state.role === null ? null : { role: state.role },
                error: null,
              }),
            }),
          }),
        }),
      }),
      rpc: async (name: string, params: unknown) => {
        state.rpcCalls.push({ name, params });
        // None of the tests here are meant to reach the RPC; a benign
        // refusal keeps a bug from silently succeeding instead of failing
        // the assertion on state.rpcCalls.
        return { data: null, error: { code: "23503" } };
      },
    },
    applyHeldRemovals: () => {},
  }),
}));

import { MAX_JSON_BODY_BYTES } from "@/lib/http/api";

import { POST as createDisclosure } from "@/app/api/organizations/[organizationId]/ai-systems/[systemId]/disclosures/route";
import {
  apiRequest,
  readError,
} from "@/tests/security/tenant-isolation/support/api-requests";

const VALID_BODY = {
  message: "A brief notice.",
  language: "en",
  enabled: true,
  expectedVersion: null,
};

function create(options: Parameters<typeof apiRequest>[2] = {}) {
  return createDisclosure(
    apiRequest(
      "POST",
      `/api/organizations/${ORG}/ai-systems/${SYSTEM}/disclosures`,
      { body: VALID_BODY, ...options },
    ),
    { params: Promise.resolve({ organizationId: ORG, systemId: SYSTEM }) },
  );
}

afterEach(() => {
  state.signedIn = true;
  state.role = "member";
  state.rpcCalls = [];
});

describe("cross-origin requests", () => {
  it("a cross-origin POST is refused 403, before authentication", async () => {
    // Would be 401 if authentication ran first: proves the same-origin
    // check is the very first thing the route does (TASK-017 invariants).
    state.signedIn = false;

    const response = await create({ origin: "https://attacker.example" });

    expect(response.status).toBe(403);
    expect((await readError(response)).code).toBe(
      "cross_origin_request_refused",
    );
    expect(state.rpcCalls).toEqual([]);
  });
});

describe("authorization", () => {
  it("a viewer is refused 403 before the body is read, even an invalid one", async () => {
    // The route itself requires disclosures.manage: were it to ask only for
    // organization.read, a viewer would reach validation and get 400 here.
    // The query layer refuses a viewer too, but only after validation.
    state.role = "viewer";

    const response = await create({ body: { ...VALID_BODY, message: "" } });

    expect(response.status).toBe(403);
    expect(state.rpcCalls).toEqual([]);
  });
});

describe("the body", () => {
  it("the wrong content type is refused 415, and nothing is published", async () => {
    const response = await create({ contentType: "text/plain" });

    expect(response.status).toBe(415);
    expect((await readError(response)).code).toBe("unsupported_media_type");
    expect(state.rpcCalls).toEqual([]);
  });

  it("a body over the size limit is refused 413, and nothing is published", async () => {
    const response = await create({
      rawBody: JSON.stringify({
        ...VALID_BODY,
        message: "x".repeat(MAX_JSON_BODY_BYTES),
      }),
    });

    expect(response.status).toBe(413);
    expect((await readError(response)).code).toBe("request_too_large");
    expect(state.rpcCalls).toEqual([]);
  });

  it.each([
    ["organizationId", () => ORG],
    ["aiSystemId", () => SYSTEM],
    ["id", () => randomUUID()],
    ["version", () => 1],
    ["createdBy", () => USER],
    ["createdAt", () => "2026-09-22T00:00:00Z"],
  ])(
    "a body carrying a smuggled %s field is refused 400, and nothing is published",
    async (field, value) => {
      const response = await create({
        body: { ...VALID_BODY, [field]: value() },
      });

      expect(response.status).toBe(400);
      expect((await readError(response)).code).toBe("invalid_request");
      expect(state.rpcCalls).toEqual([]);
    },
  );
});

describe("error bodies", () => {
  it("carry only a code and a reference, whatever the failure", async () => {
    const response = await create({ contentType: "text/plain" });
    const forShapeCheck = response.clone();

    // readError enforces the exact shape (only "code" and "reference",
    // "reference" matching err_<12 hex>); a failure here throws.
    await expect(readError(forShapeCheck)).resolves.toMatchObject({
      code: "unsupported_media_type",
    });

    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["error"]);
    const error = body.error as Record<string, unknown>;
    expect(Object.keys(error).sort()).toEqual(["code", "reference"]);
  });
});
