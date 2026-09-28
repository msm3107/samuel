import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Reading a deployment's verification history through its route, against the
 * real local database (TASK-026).
 *
 * Through the route rather than by calling the query directly, so the
 * authorization, the cursor parsing and the 404 are all the real ones and the
 * session client runs under a real user's JWT with real row-level security. The
 * alternative — handing the query a hand-built `OrganizationAccess` — would need
 * a cast, and a cast is how a test stops proving the thing it is named after.
 *
 * What only a real round trip can show: that the embed and its composite
 * foreign key work at all; that another organization's deployment is a 404
 * rather than an empty page; that every role including a viewer may read; and —
 * the claim the cursor choice rests on — that paging across a boundary repeats
 * no row and skips none.
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

import { GET as listChecks } from "@/app/api/organizations/[organizationId]/deployments/[deploymentId]/verification-checks/route";
import { recordVerificationCheck } from "@/features/verification/verification-queries";
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
import { VERIFICATION_LIST_LIMIT } from "@/features/verification/verification-history-queries";

const fixtures = createTenantFixtures();
// No service-role client here. Every fixture is created as a signed-in user and
// every read goes through the route, so nothing in this suite can pass a
// boundary the real caller could not. The checks themselves are written by
// `recordVerificationCheck`, which is the scheduler's own writer.

let owner: TestUser;
let ownerClient: SupabaseClient;
let organization: TestOrganization;
let other: TestOrganization;

type HistoryBody = {
  deploymentStatus: string;
  checks: { id: string; checkWindow: string; status: string }[];
  truncated: boolean;
};

/** The route, as a signed-in member of `organizationId` would reach it. */
async function read(
  organizationId: string,
  deploymentId: string,
  query = "",
): Promise<Response> {
  const path = `/api/organizations/${organizationId}/deployments/${deploymentId}/verification-checks${query}`;
  return listChecks(apiRequest("GET", path), {
    params: Promise.resolve({ organizationId, deploymentId }),
  });
}

async function readHistory(
  organizationId: string,
  deploymentId: string,
  query = "",
): Promise<HistoryBody> {
  const response = await read(organizationId, deploymentId, query);
  expect(response.status).toBe(200);
  return (await response.json()) as HistoryBody;
}

beforeAll(async () => {
  owner = await fixtures.createUser();
  ownerClient = await fixtures.signedInClient(owner);
  organization = await fixtures.createOrganization({ ownerId: owner.id });
  other = await fixtures.createOrganization({ ownerId: owner.id });
  actAs(owner, ownerClient);
}, 30_000);

afterAll(async () => {
  await fixtures.cleanup();
});

/** A deployment with a published notice, in `organizationId`. */
async function createDeployment(organizationId: string): Promise<{
  deploymentId: string;
  disclosureId: string;
}> {
  const system = await ownerClient
    .from("ai_systems")
    .insert({
      organization_id: organizationId,
      name: `History ${randomUUID().slice(0, 8)}`,
      system_type: "chatbot",
    })
    .select("id")
    .single();
  expect(system.error).toBeNull();
  const aiSystemId = (system.data as { id: string }).id;

  const disclosure = await ownerClient
    .from("disclosures")
    .insert({
      organization_id: organizationId,
      ai_system_id: aiSystemId,
      message: "You are interacting with an AI system.",
      language: "en",
    })
    .select("id")
    .single();
  expect(disclosure.error).toBeNull();

  const deployment = await ownerClient
    .from("deployments")
    .insert({
      organization_id: organizationId,
      ai_system_id: aiSystemId,
      hostname: `h${randomUUID().slice(0, 8)}.example.com`,
    })
    .select("id")
    .single();
  expect(deployment.error).toBeNull();

  return {
    deploymentId: (deployment.data as { id: string }).id,
    disclosureId: (disclosure.data as { id: string }).id,
  };
}

/**
 * `count` checks, one window per day, oldest first. Every window is in the past:
 * `check (check_window <= checked_at)` refuses one that begins after the check
 * happened.
 */
async function recordChecks(
  organizationId: string,
  deploymentId: string,
  disclosureId: string,
  count: number,
): Promise<string[]> {
  const windows: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const checkWindow = new Date(Date.UTC(2020, 0, 1) + index * 86_400_000);
    const failed = index % 3 === 0;
    const written = await recordVerificationCheck({
      organizationId,
      deploymentId,
      disclosureId,
      checkWindow,
      status: failed ? "failure" : "success",
      failureCode: failed ? "WIDGET_NOT_FOUND" : null,
      httpStatus: 200,
      widgetDetected: !failed,
      metadata: { widget_tags: failed ? 0 : 1 },
    });
    expect(written).toBe(true);
    windows.push(checkWindow.toISOString());
  }
  return windows;
}

describe("one deployment's history", () => {
  it("comes back newest first, with the deployment's status", async () => {
    const { deploymentId, disclosureId } = await createDeployment(
      organization.id,
    );
    const windows = await recordChecks(
      organization.id,
      deploymentId,
      disclosureId,
      5,
    );

    const body = await readHistory(organization.id, deploymentId);

    expect(body.deploymentStatus).toBe("active");
    expect(body.truncated).toBe(false);
    // Compared as instants, not as strings: PostgREST spells a timestamptz
    // `2020-01-05T00:00:00+00:00` and every serializer in this codebase passes
    // the database's spelling through, so asserting on the text would be
    // asserting on PostgREST's formatting rather than on the order.
    expect(body.checks.map((check) => Date.parse(check.checkWindow))).toEqual(
      [...windows].reverse().map((value) => Date.parse(value)),
    );
  });

  it("carries no metadata to the client", async () => {
    const { deploymentId, disclosureId } = await createDeployment(
      organization.id,
    );
    await recordChecks(organization.id, deploymentId, disclosureId, 1);

    const response = await read(organization.id, deploymentId);
    const text = await response.text();

    expect(text).not.toContain("metadata");
    expect(text).not.toContain("widget_tags");
    expect(text).not.toContain("organizationId");
  });

  it("is an empty page for a deployment that has never been checked", async () => {
    // Not a 404: the deployment exists. The two are different facts.
    const { deploymentId } = await createDeployment(organization.id);

    expect(await readHistory(organization.id, deploymentId)).toMatchObject({
      checks: [],
      truncated: false,
    });
  });

  it("is a 404 for a deployment this organization does not have", async () => {
    // Which includes another organization's, so the answer says nothing about
    // whether it exists.
    const { deploymentId } = await createDeployment(other.id);

    const response = await read(organization.id, deploymentId);

    expect(response.status).toBe(404);
    expect((await readError(response)).code).toBe("deployment_not_found");
  });

  it("is a 404 for a deployment id that is not a UUID, with no query made", async () => {
    const response = await read(organization.id, "not-a-uuid");

    expect(response.status).toBe(404);
  });

  it("stays readable once the deployment is archived", async () => {
    // TASK-022 keeps an archived deployment's evidence, so the history has to
    // remain readable and has to say which it is.
    const { deploymentId, disclosureId } = await createDeployment(
      organization.id,
    );
    await recordChecks(organization.id, deploymentId, disclosureId, 2);
    const archived = await ownerClient
      .from("deployments")
      .update({ status: "archived" })
      .eq("id", deploymentId);
    expect(archived.error).toBeNull();

    const body = await readHistory(organization.id, deploymentId);

    expect(body.deploymentStatus).toBe("archived");
    expect(body.checks).toHaveLength(2);
  });

  it("is readable by a viewer", async () => {
    // Evidence is the thing customers rely on, so `organization.read` is
    // `viewer` and there is no role that may not read it.
    const viewer = await fixtures.createUser();
    const viewerClient = await fixtures.signedInClient(viewer);
    await fixtures.addMember(organization.id, viewer.id, "viewer");
    const { deploymentId, disclosureId } = await createDeployment(
      organization.id,
    );
    await recordChecks(organization.id, deploymentId, disclosureId, 1);

    actAs(viewer, viewerClient);
    try {
      expect(
        (await readHistory(organization.id, deploymentId)).checks,
      ).toHaveLength(1);
    } finally {
      actAs(owner, ownerClient);
    }
  });

  it("refuses a caller with no role in the organization", async () => {
    const stranger = await fixtures.createUser();
    const strangerClient = await fixtures.signedInClient(stranger);
    const { deploymentId } = await createDeployment(organization.id);

    actAs(stranger, strangerClient);
    try {
      const response = await read(organization.id, deploymentId);
      expect(response.status).toBe(403);
    } finally {
      actAs(owner, ownerClient);
    }
  });
});

describe("paging", () => {
  it("cuts a long history off at the limit and says so", async () => {
    const { deploymentId, disclosureId } = await createDeployment(
      organization.id,
    );
    // Two more than a page, so the boundary falls inside the rows.
    await recordChecks(
      organization.id,
      deploymentId,
      disclosureId,
      VERIFICATION_LIST_LIMIT + 2,
    );

    const body = await readHistory(organization.id, deploymentId);

    expect(body.checks).toHaveLength(VERIFICATION_LIST_LIMIT);
    expect(body.truncated).toBe(true);
  });

  it("reaches the rest with the last row's window, repeating nothing and skipping nothing", async () => {
    const { deploymentId, disclosureId } = await createDeployment(
      organization.id,
    );
    const total = VERIFICATION_LIST_LIMIT + 2;
    await recordChecks(organization.id, deploymentId, disclosureId, total);

    const first = await readHistory(organization.id, deploymentId);
    const last = first.checks.at(-1);
    expect(last).toBeDefined();

    const second = await readHistory(
      organization.id,
      deploymentId,
      `?before=${encodeURIComponent(last?.checkWindow ?? "")}`,
    );

    expect(second.checks).toHaveLength(2);
    expect(second.truncated).toBe(false);

    // The whole history in two requests: every row exactly once, newest first
    // throughout. This is the claim choosing `check_window` over `checked_at`
    // rests on — the unique constraint makes a skip impossible.
    const all = [...first.checks, ...second.checks];
    expect(new Set(all.map((check) => check.id)).size).toBe(total);
    const windows = all.map((check) => check.checkWindow);
    expect([...windows].sort().reverse()).toEqual(windows);
  });

  it("excludes the cursor's own row, so a boundary cannot repeat one", async () => {
    const { deploymentId, disclosureId } = await createDeployment(
      organization.id,
    );
    const windows = await recordChecks(
      organization.id,
      deploymentId,
      disclosureId,
      4,
    );
    const newest = windows.at(-1) ?? "";

    const body = await readHistory(
      organization.id,
      deploymentId,
      `?before=${encodeURIComponent(newest)}`,
    );

    expect(body.checks).toHaveLength(3);
    // As instants. Comparing the strings would have made this assertion
    // unfalsifiable, because the two spellings of the same time never match.
    expect(
      body.checks.some(
        (check) => Date.parse(check.checkWindow) === Date.parse(newest),
      ),
    ).toBe(false);
  });

  it("gives an empty page for a cursor older than every check", async () => {
    const { deploymentId, disclosureId } = await createDeployment(
      organization.id,
    );
    await recordChecks(organization.id, deploymentId, disclosureId, 3);

    // The deployment is still found: the cursor filters the checks, not it.
    expect(
      await readHistory(
        organization.id,
        deploymentId,
        "?before=1990-01-01T00%3A00%3A00.000Z",
      ),
    ).toMatchObject({ checks: [], truncated: false });
  });

  it("refuses a malformed cursor rather than ignoring it", async () => {
    const { deploymentId } = await createDeployment(organization.id);

    for (const cursor of ["2026-09-27", "soon", "", "0"]) {
      const response = await read(
        organization.id,
        deploymentId,
        `?before=${encodeURIComponent(cursor)}`,
      );

      expect(response.status).toBe(400);
      expect((await readError(response)).code).toBe("invalid_cursor");
    }
  });

  it("refuses a repeated cursor, both values well formed", async () => {
    // Two cursors are two different pages. Taking the first would answer a
    // question the caller did not ask, so this is a 400 — the same answer the
    // disclosures and deployments lists give a repeated parameter, and the
    // ambiguity half of README §31's rule (PR #43 review, note 2).
    const { deploymentId } = await createDeployment(organization.id);

    const response = await read(
      organization.id,
      deploymentId,
      "?before=2026-09-27T00%3A00%3A00.000Z&before=2020-01-01T00%3A00%3A00.000Z",
    );

    expect(response.status).toBe(400);
    expect((await readError(response)).code).toBe("invalid_cursor");
  });
});
