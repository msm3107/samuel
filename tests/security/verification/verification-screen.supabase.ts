import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Who may read a deployment's verification history, and what the page puts on
 * the screen (TASK-027), against the real local database.
 *
 * The boundary that can fail is the tenant one, and it needs real row-level
 * security. There is deliberately no test for "a role below
 * `organization.read`": the permission maps to `viewer`, the lowest role there
 * is, so such a test could not fail — evidence is the thing customers rely on
 * and no member is excluded from it (TASK-026).
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

import ChecksPage from "@/app/(dashboard)/dashboard/[organizationId]/deployments/[deploymentId]/checks/page";
import { recordVerificationCheck } from "@/features/verification/verification-queries";
import { actAs } from "@/tests/security/tenant-isolation/support/acting-user";
import {
  createTenantFixtures,
  type TestOrganization,
  type TestUser,
} from "@/tests/security/tenant-isolation/support/tenants";
import { renderPage, type Outcome } from "@/tests/support/next-interrupts";

const fixtures = createTenantFixtures();

let owner: TestUser;
let ownerClient: SupabaseClient;
let organization: TestOrganization;
let other: TestOrganization;

/** A deployment with a check that recorded as much metadata as one can. */
let deploymentId: string;
let disclosureId: string;

beforeAll(async () => {
  owner = await fixtures.createUser();
  ownerClient = await fixtures.signedInClient(owner);
  organization = await fixtures.createOrganization({ ownerId: owner.id });
  other = await fixtures.createOrganization({ ownerId: owner.id });
  actAs(owner, ownerClient);

  const created = await createDeployment(organization.id);
  deploymentId = created.deploymentId;
  disclosureId = created.disclosureId;

  await recordVerificationCheck({
    organizationId: organization.id,
    deploymentId,
    disclosureId,
    checkWindow: new Date(Date.UTC(2021, 0, 1)),
    status: "failure",
    failureCode: "WIDGET_NOT_FOUND",
    httpStatus: 200,
    widgetDetected: false,
    metadata: {
      scheme: "https",
      redirects: 2,
      final_host: "cdn.internal.example.net",
      response_bytes: 4096,
      duration_ms: 812,
      content_type: "text/html; charset=windows-1252",
      charset: "windows-1252",
      widget_tags: 0,
      widget_reason: "FOREIGN_ORIGIN",
    },
  });
}, 30_000);

afterAll(async () => {
  await fixtures.cleanup();
});

async function createDeployment(organizationId: string): Promise<{
  deploymentId: string;
  disclosureId: string;
}> {
  const system = await ownerClient
    .from("ai_systems")
    .insert({
      organization_id: organizationId,
      name: `Isolation ${randomUUID().slice(0, 8)}`,
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
      hostname: `i${randomUUID().slice(0, 8)}.example.com`,
    })
    .select("id")
    .single();
  expect(deployment.error).toBeNull();

  return {
    deploymentId: (deployment.data as { id: string }).id,
    disclosureId: (disclosure.data as { id: string }).id,
  };
}

async function render(
  organizationId: string,
  deployment: string,
): Promise<Outcome> {
  return renderPage(() =>
    ChecksPage({
      params: Promise.resolve({ organizationId, deploymentId: deployment }),
      searchParams: Promise.resolve({}),
    }),
  );
}

describe("what the page puts on the screen", () => {
  it("shows the two reasons and no other metadata", async () => {
    const outcome = await render(organization.id, deploymentId);
    expect(outcome.kind).toBe("rendered");
    const page = outcome.kind === "rendered" ? outcome.html : "";

    // The one value the owner accepted as customer-facing, rendered as words.
    expect(page).toContain("A copy on your own site");

    // Everything else `metadata` holds is ours, for support. `final_host` is
    // the one that matters most: a hostname a redirect chain reached, which has
    // no business on a screen.
    //
    // Identifiers are removed first: they are hexadecimal, so a UUID in a link
    // this page legitimately builds can contain any short digit string by
    // chance, and an assertion that fails one run in a hundred is worse than
    // none. `response_bytes` and `duration_ms` are therefore not asserted here
    // at all — their values are too short to assert on honestly, and the
    // serializer's own key list, which has no field for either, is what pins
    // them (tests/security/verification/verification-history-surface.test.ts).
    const text = page.replaceAll(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      "",
    );
    for (const secret of [
      "cdn.internal.example.net",
      "windows-1252",
      "text/html",
      "FOREIGN_ORIGIN",
      "WIDGET_NOT_FOUND",
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("names no identifier the reader did not navigate by", async () => {
    const outcome = await render(organization.id, deploymentId);
    const page = outcome.kind === "rendered" ? outcome.html : "";

    // The disclosure the check was made against, and the check's own id, are
    // internal. The organization and the deployment are in the path the reader
    // already followed, so they are in the links this page builds.
    expect(page).not.toContain(disclosureId);
  });
});

describe("another organization's deployment", () => {
  it("is not found, not an empty history", async () => {
    // The same 404 as a deployment that does not exist, so it says nothing
    // about whether it does.
    expect((await render(other.id, deploymentId)).kind).toBe("not_found");
  });

  it("is not found when its own organization is named either", async () => {
    const elsewhere = await createDeployment(other.id);

    expect((await render(organization.id, elsewhere.deploymentId)).kind).toBe(
      "not_found",
    );
  });
});

describe("a deployment id that is not one", () => {
  it("is not found, with no query made for it", async () => {
    expect((await render(organization.id, "not-a-uuid")).kind).toBe(
      "not_found",
    );
  });

  it("is not found when it is a well-formed id for nothing", async () => {
    expect((await render(organization.id, randomUUID())).kind).toBe(
      "not_found",
    );
  });
});

describe("a viewer", () => {
  it("reads the history, because evidence is what customers rely on", async () => {
    const viewer = await fixtures.createUser();
    const viewerClient = await fixtures.signedInClient(viewer);
    await fixtures.addMember(organization.id, viewer.id, "viewer");
    actAs(viewer, viewerClient);

    try {
      const outcome = await render(organization.id, deploymentId);
      expect(outcome.kind).toBe("rendered");
      expect(outcome.kind === "rendered" ? outcome.html : "").toContain(
        "Failed",
      );
    } finally {
      actAs(owner, ownerClient);
    }
  });
});

describe("somebody with no membership at all", () => {
  it("is not found, and learns nothing about the organization", async () => {
    const stranger = await fixtures.createUser();
    const strangerClient = await fixtures.signedInClient(stranger);
    actAs(stranger, strangerClient);

    try {
      expect((await render(organization.id, deploymentId)).kind).toBe(
        "not_found",
      );
    } finally {
      actAs(owner, ownerClient);
    }
  });
});
