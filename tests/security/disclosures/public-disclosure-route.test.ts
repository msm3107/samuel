import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The public disclosure endpoint (TASK-019a), with the limiter and the
 * database faked. The real-database suite proves the notice comes back; this
 * one proves the things a caller could otherwise make this endpoint do —
 * that a malformed identifier costs no limiter call and no query, that only
 * answers which are a pure function of the URL are cacheable, that a
 * refusal or an outage is never handed to a shared cache, that the body
 * carries three keys and nothing else, and that nothing a caller can
 * provoke writes a log entry.
 */

const VALID_ID = "dep_7k2m4qphr6vt3wzc5nxa7jd2fb";

const state = vi.hoisted(() => ({
  /** Every limit consumed, in order. */
  limits: [] as string[],
  /** Names of limits that refuse, and of limits that cannot answer. */
  refuse: new Set<string>(),
  unavailable: new Set<string>(),
  /** Every RPC the route made. */
  rpcCalls: [] as Array<{ name: string; params: unknown }>,
  answer: { data: [] as unknown, error: null as unknown },
  logs: [] as unknown[],
}));

vi.mock("@/lib/security/rate-limit", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/security/rate-limit")>();
  return {
    ...actual,
    consumeRateLimit: async (name: string) => {
      state.limits.push(name);
      if (state.unavailable.has(name)) {
        throw new actual.RateLimitUnavailableError(`${name} unavailable`);
      }
      return !state.refuse.has(name);
    },
  };
});

vi.mock("@/lib/database/public-client", () => ({
  createPublicClient: () => ({
    rpc: async (name: string, params: unknown) => {
      state.rpcCalls.push({ name, params });
      return state.answer;
    },
  }),
}));

vi.mock("@/lib/logging/logger", () => ({
  logger: {
    info: (entry: unknown) => state.logs.push(entry),
    warn: (entry: unknown) => state.logs.push(entry),
    error: (entry: unknown) => state.logs.push(entry),
  },
}));

import { GET } from "@/app/api/public/disclosure/[publicId]/route";
import { PUBLIC_CACHE_CONTROL } from "@/lib/http/public-api";

const NOTICE = {
  version: 3,
  language: "en",
  message: "You are interacting with an AI system.",
};

/**
 * The ceiling alert and the fault log are bounded per process and per
 * window (PR #36 review, notes 2 and 4), which is module state that would
 * otherwise leak from one test into the next. Each test gets its own hour,
 * and the two tests that exercise a window advance the clock themselves.
 * Only `Date` is faked, so the route's promises still settle.
 */
let clock = Date.UTC(2026, 8, 26, 12);

beforeEach(() => {
  clock += 3_600_000;
  vi.useFakeTimers({ toFake: ["Date"], now: clock });
});

afterEach(() => {
  vi.useRealTimers();
  state.limits.length = 0;
  state.refuse.clear();
  state.unavailable.clear();
  state.rpcCalls.length = 0;
  state.answer = { data: [], error: null };
  state.logs.length = 0;
});

function call(publicId: string): Promise<Response> {
  return GET(
    new Request(`http://localhost:3000/api/public/disclosure/${publicId}`),
    {
      params: Promise.resolve({ publicId }),
    },
  );
}

/** Every response, whatever its status, carries these two. */
function expectAlwaysSet(response: Response) {
  expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  // The route sets no `Vary` and no `Set-Cookie`: nothing about a visitor
  // may reach a shared cache, and nothing should split it by origin.
  // Next.js adds a `Vary` of its own downstream, naming only its router
  // headers; the end-to-end spec asserts it names neither cookie nor
  // origin.
  expect(response.headers.get("Vary")).toBeNull();
  expect(response.headers.get("Set-Cookie")).toBeNull();
}

describe("the public disclosure endpoint", () => {
  it("answers an active deployment with the notice and nothing else", async () => {
    state.answer = { data: [NOTICE], error: null };

    const response = await call(VALID_ID);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual(NOTICE);
    // No identifier, organization, system, hostname, time or author.
    expect(Object.keys(body).sort()).toEqual([
      "language",
      "message",
      "version",
    ]);
    expect(response.headers.get("Cache-Control")).toBe(PUBLIC_CACHE_CONTROL);
    expectAlwaysSet(response);
    expect(state.rpcCalls).toEqual([
      { name: "public_disclosure", params: { p_public_id: VALID_ID } },
    ]);
  });

  it("answers 404 with a code and no reference when there is nothing to show", async () => {
    state.answer = { data: [], error: null };

    const response = await call(VALID_ID);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "disclosure_not_found" },
    });
    // Cached like a hit: an enumeration attempt is absorbed by the shared
    // cache too, and the answer is a pure function of the URL.
    expect(response.headers.get("Cache-Control")).toBe(PUBLIC_CACHE_CONTROL);
    expectAlwaysSet(response);
    // No log entry: an unknown identifier is an answer, not a fault, so the
    // caller does not decide this application's log volume.
    expect(state.logs).toEqual([]);
  });

  it.each([
    // The exact identifier, upper-cased: the case TASK-019's review asked
    // to make legible (PR #35, note 4).
    VALID_ID.toUpperCase(),
    `DEP_${VALID_ID.slice(4)}`,
    VALID_ID.slice(0, -1),
    `${VALID_ID}a`,
    VALID_ID.replace("dep_", "dep-"),
    // base32 has no 0, 1, 8 or 9.
    `dep_0${VALID_ID.slice(5)}`,
    "dep_",
    "",
    "../../organizations",
  ])(
    "refuses %s as malformed, without a limiter call or a query",
    async (id) => {
      const response = await call(id);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: { code: "invalid_deployment_id" },
      });
      // The whole point of checking the shape first: junk is the cheapest
      // thing this endpoint does.
      expect(state.limits).toEqual([]);
      expect(state.rpcCalls).toEqual([]);
      // Deterministic per URL, so it is cacheable like the other answers.
      expect(response.headers.get("Cache-Control")).toBe(PUBLIC_CACHE_CONTROL);
      expectAlwaysSet(response);
      expect(state.logs).toEqual([]);
    },
  );

  it("refuses a network past its limit, and never lets that be cached", async () => {
    state.refuse.add("publicDisclosureNetwork");

    const response = await call(VALID_ID);

    expect(response.status).toBe(429);
    expect(await response.json()).toEqual({ error: { code: "rate_limited" } });
    // A shared cache must never hand one caller's refusal to everyone else.
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Retry-After")).toBe("300");
    expectAlwaysSet(response);
    expect(state.rpcCalls).toEqual([]);
    // Past the limit every further request would write a line, which would
    // hand the caller the log volume as well.
    expect(state.logs).toEqual([]);
  });

  it("spends the network limit before the service-wide counter", async () => {
    state.answer = { data: [NOTICE], error: null };

    await call(VALID_ID);

    expect(state.limits).toEqual([
      "publicDisclosureNetwork",
      "publicDisclosureGlobal",
    ]);
  });

  it("still serves the notice past the service-wide counter, and alerts once", async () => {
    state.answer = { data: [NOTICE], error: null };
    state.refuse.add("publicDisclosureGlobal");

    const response = await call(VALID_ID);

    // Alert-only (owner, 2026-09-26): a ceiling that refused would take
    // every customer's notice off every customer's site at once.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(NOTICE);
    expect(state.limits).toEqual([
      "publicDisclosureNetwork",
      "publicDisclosureGlobal",
      "publicDisclosureCeilingAlert",
    ]);
    expect(state.logs).toEqual([
      { event: "public_disclosure_ceiling_reached" },
    ]);
  });

  it("logs nothing more once the alert bucket is spent", async () => {
    state.answer = { data: [NOTICE], error: null };
    state.refuse.add("publicDisclosureGlobal");
    state.refuse.add("publicDisclosureCeilingAlert");

    const response = await call(VALID_ID);

    expect(response.status).toBe(200);
    expect(state.logs).toEqual([]);
  });

  it("asks the alert bucket once per window, however long the flood lasts", async () => {
    state.answer = { data: [NOTICE], error: null };
    state.refuse.add("publicDisclosureGlobal");

    await call(VALID_ID);
    await call(VALID_ID);
    await call(VALID_ID);

    // PR #36 review, note 2: past the ceiling, asking on every request
    // would add a third database write per request at the busiest moment.
    // The bucket is asked once; the ceiling itself is still counted every
    // time, because that is what the alert is about.
    expect(
      state.limits.filter((name) => name === "publicDisclosureCeilingAlert"),
    ).toEqual(["publicDisclosureCeilingAlert"]);
    expect(
      state.limits.filter((name) => name === "publicDisclosureGlobal").length,
    ).toBe(3);
    expect(state.logs).toEqual([
      { event: "public_disclosure_ceiling_reached" },
    ]);
  });

  it("asks again once the window has passed", async () => {
    state.answer = { data: [NOTICE], error: null };
    state.refuse.add("publicDisclosureGlobal");

    await call(VALID_ID);
    vi.setSystemTime(clock + 301_000);
    await call(VALID_ID);

    // A flood that outlasts the window is still worth a second entry: the
    // bound is on volume, not on ever hearing about it again.
    expect(
      state.limits.filter((name) => name === "publicDisclosureCeilingAlert")
        .length,
    ).toBe(2);
    expect(state.logs).toHaveLength(2);
  });

  it("logs one entry for a run of identical faults, and still references each", async () => {
    state.unavailable.add("publicDisclosureNetwork");

    const first = await call(VALID_ID);
    const second = await call(VALID_ID);
    const firstBody = (await first.json()) as { error: { reference: string } };
    const secondBody = (await second.json()) as {
      error: { reference: string };
    };

    // PR #36 review, note 4: during an outage every request is a fault and
    // a 503 is `no-store`, so nothing absorbs the repeats. The caller still
    // gets a reference each time; what is bounded is what we write.
    expect(second.status).toBe(503);
    expect(secondBody.error.reference).toMatch(/^err_[0-9a-f]{12}$/);
    expect(secondBody.error.reference).not.toBe(firstBody.error.reference);
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0]).toMatchObject({
      code: "service_unavailable",
      reference: firstBody.error.reference,
      boundedForSeconds: 60,
    });
  });

  it("still logs a different fault while one is bounded", async () => {
    state.unavailable.add("publicDisclosureNetwork");
    await call(VALID_ID);
    state.unavailable.clear();
    state.answer = { data: [{ ...NOTICE, extra: true }], error: null };

    const response = await call(VALID_ID);

    // The bound is per code, so an unreadable row during an outage is not
    // swallowed by the outage's own entry.
    expect(response.status).toBe(500);
    expect(state.logs).toHaveLength(2);
    expect(state.logs[1]).toMatchObject({ code: "internal_error" });
  });

  it("serves the notice when the service-wide counter cannot answer", async () => {
    state.answer = { data: [NOTICE], error: null };
    state.unavailable.add("publicDisclosureGlobal");

    const response = await call(VALID_ID);

    // The counter cannot refuse a request, so its own failure cannot either.
    expect(response.status).toBe(200);
    expect(state.logs).toEqual([
      { event: "public_disclosure_counter_unavailable" },
    ]);
  });

  it("refuses the request when the network limiter cannot answer", async () => {
    state.unavailable.add("publicDisclosureNetwork");

    const response = await call(VALID_ID);
    const body = (await response.json()) as { error: Record<string, unknown> };

    // Fails closed: a limit that disappears when the database is slow
    // protects nothing — and the lookup would have failed anyway, because
    // the limiter and the lookup are the same database.
    expect(response.status).toBe(503);
    expect(body.error.code).toBe("service_unavailable");
    expect(body.error.reference).toMatch(/^err_[0-9a-f]{12}$/);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(state.rpcCalls).toEqual([]);
  });

  it("answers 503 when the database refuses, without saying why", async () => {
    state.answer = {
      data: null,
      error: {
        code: "42501",
        message: "permission denied for function",
        hint: "grant it",
      },
    };

    const response = await call(VALID_ID);
    const body = (await response.json()) as { error: Record<string, unknown> };

    expect(response.status).toBe(503);
    expect(Object.keys(body.error).sort()).toEqual(["code", "reference"]);
    expect(JSON.stringify(body)).not.toContain("permission denied");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it.each([
    // A column added to the function's return type.
    [[{ ...NOTICE, organizationId: "0f6b2a4c-8d1e-4f3a-9b5c-6e7d8a9b0c1d" }]],
    // A second row, which the function cannot produce today.
    [[NOTICE, { ...NOTICE, version: 2 }]],
    // A language outside the published list, and a version out of range.
    [[{ ...NOTICE, language: "xx" }]],
    [[{ ...NOTICE, version: 0 }]],
    [[{ version: 3, language: "en" }]],
  ])("answers 500 rather than forward an unreadable row", async (data) => {
    state.answer = { data, error: null };

    const response = await call(VALID_ID);
    const body = (await response.json()) as { error: Record<string, unknown> };

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("internal_error");
    // Nothing of the row reaches the caller, extra key least of all.
    expect(JSON.stringify(body)).not.toContain("organizationId");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});
