import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The verification history screen against the real local database (TASK-027):
 * what a customer sees for a deployment that passed, one that failed, one never
 * checked, and one that was archived — and that paging reaches the whole
 * history. Isolation is in
 * tests/security/verification/verification-screen.supabase.ts.
 *
 * Rendered rather than asserted on a query's return value, because what this
 * task delivers is the page: a reason that is stored and never shown is the
 * defect the PR #43 review found, and only rendering catches it.
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
import DeploymentPage from "@/app/(dashboard)/dashboard/[organizationId]/deployments/[deploymentId]/page";
import { recordVerificationCheck } from "@/features/verification/verification-queries";
import { actAs } from "@/tests/security/tenant-isolation/support/acting-user";
import {
  createTenantFixtures,
  type TestOrganization,
  type TestUser,
} from "@/tests/security/tenant-isolation/support/tenants";
import { renderPage } from "@/tests/support/next-interrupts";

const fixtures = createTenantFixtures();

let owner: TestUser;
let ownerClient: SupabaseClient;
let organization: TestOrganization;

beforeAll(async () => {
  owner = await fixtures.createUser();
  ownerClient = await fixtures.signedInClient(owner);
  organization = await fixtures.createOrganization({ ownerId: owner.id });
  actAs(owner, ownerClient);
}, 30_000);

afterAll(async () => {
  await fixtures.cleanup();
});

async function renderChecks(
  deploymentId: string,
  query: Record<string, string | string[] | undefined> = {},
) {
  return renderPage(() =>
    ChecksPage({
      params: Promise.resolve({
        organizationId: organization.id,
        deploymentId,
      }),
      searchParams: Promise.resolve(query),
    }),
  );
}

function html(outcome: Awaited<ReturnType<typeof renderChecks>>): string {
  expect(outcome.kind).toBe("rendered");
  return outcome.kind === "rendered" ? outcome.html : "";
}

/** A deployment with a published notice, in `organizationId`. */
async function createDeployment(organizationId: string): Promise<{
  deploymentId: string;
  disclosureId: string;
}> {
  const system = await ownerClient
    .from("ai_systems")
    .insert({
      organization_id: organizationId,
      name: `Screen ${randomUUID().slice(0, 8)}`,
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
      hostname: `s${randomUUID().slice(0, 8)}.example.com`,
    })
    .select("id")
    .single();
  expect(deployment.error).toBeNull();

  return {
    deploymentId: (deployment.data as { id: string }).id,
    disclosureId: (disclosure.data as { id: string }).id,
  };
}

/** One window per day, oldest first, every one of them in the past. */
function windowAt(index: number): Date {
  return new Date(Date.UTC(2021, 0, 1) + index * 86_400_000);
}

describe("a deployment that has never been checked", () => {
  it("says so, and says how often checks run, without promising when", async () => {
    const { deploymentId } = await createDeployment(organization.id);

    const page = html(await renderChecks(deploymentId));

    expect(page).toContain("No checks recorded yet");
    expect(page).toContain("checked once a day");
    // The schedule is enabled outside the application, so the screen may not
    // say when this deployment&rsquo;s first check will happen.
    expect(page).not.toMatch(/within \d|next check|will be checked/i);
  });
});

describe("a failed check", () => {
  it("names what happened and what to change, from the stored reason", async () => {
    const { deploymentId, disclosureId } = await createDeployment(
      organization.id,
    );
    await recordVerificationCheck({
      organizationId: organization.id,
      deploymentId,
      disclosureId,
      checkWindow: windowAt(0),
      status: "failure",
      failureCode: "WIDGET_NOT_FOUND",
      httpStatus: 200,
      widgetDetected: false,
      metadata: { widget_tags: 0, widget_reason: "FOREIGN_ORIGIN" },
    });

    const page = html(await renderChecks(deploymentId));

    expect(page).toContain("Failed");
    expect(page).toContain("Notice not found");
    // The whole point of the PR #43 amendment: `WIDGET_NOT_FOUND` alone cannot
    // tell this customer that the tag loads a copy from their own site.
    expect(page).toContain("A copy on your own site");
    expect(page).toContain("load the script from the address in the install");
    // The code itself is for logs and support, not for a screen.
    expect(page).not.toContain("FOREIGN_ORIGIN");
    expect(page).not.toContain("WIDGET_NOT_FOUND");
  });

  it("shows the answering status only where the number is the fact", async () => {
    const { deploymentId, disclosureId } = await createDeployment(
      organization.id,
    );
    await recordVerificationCheck({
      organizationId: organization.id,
      deploymentId,
      disclosureId,
      checkWindow: windowAt(0),
      status: "failure",
      failureCode: "HTTP_ERROR",
      httpStatus: 503,
      widgetDetected: null,
      metadata: {},
    });

    expect(html(await renderChecks(deploymentId))).toContain(
      "The site answered 503",
    );
  });

  it("does not put a 200 beside a tag that was not found", async () => {
    const { deploymentId, disclosureId } = await createDeployment(
      organization.id,
    );
    await recordVerificationCheck({
      organizationId: organization.id,
      deploymentId,
      disclosureId,
      checkWindow: windowAt(0),
      status: "failure",
      failureCode: "WIDGET_NOT_FOUND",
      httpStatus: 200,
      widgetDetected: false,
      metadata: { widget_tags: 0, widget_reason: "NO_WIDGET_TAG" },
    });

    // A status beside a page that was fetched perfectly well invites the
    // reading that the check half-succeeded.
    expect(html(await renderChecks(deploymentId))).not.toContain(
      "The site answered",
    );
  });
});

describe("a passing check", () => {
  it("says the tag was found, with no failure text anywhere", async () => {
    const { deploymentId, disclosureId } = await createDeployment(
      organization.id,
    );
    await recordVerificationCheck({
      organizationId: organization.id,
      deploymentId,
      disclosureId,
      checkWindow: windowAt(0),
      status: "success",
      failureCode: null,
      httpStatus: 200,
      widgetDetected: true,
      metadata: { widget_tags: 1 },
    });

    const page = html(await renderChecks(deploymentId));

    expect(page).toContain("Passed");
    expect(page).toContain("was found on it");
    expect(page).not.toContain("Failed");
  });
});

describe("status without colour", () => {
  it("is a word and a shape, so removing the colour loses nothing", async () => {
    const { deploymentId, disclosureId } = await createDeployment(
      organization.id,
    );
    await recordVerificationCheck({
      organizationId: organization.id,
      deploymentId,
      disclosureId,
      checkWindow: windowAt(0),
      status: "failure",
      failureCode: "DNS_ERROR",
      httpStatus: null,
      widgetDetected: null,
      metadata: {},
    });

    const page = html(await renderChecks(deploymentId));

    // §35. Strip every colour class and the status must still be legible.
    const colourless = page.replaceAll(
      /(?:border|text|bg)-(?:red|emerald|green|amber|yellow)-\d{3}/g,
      "",
    );
    expect(colourless).toContain("Failed");
    expect(colourless).toContain("Hostname not found");
    // The shape is decoration beside the word, so it is hidden from a reader
    // who is being read to rather than announced twice.
    expect(page).toContain('aria-hidden="true"');
  });
});

describe("an archived deployment", () => {
  it("keeps its history and says checks have stopped", async () => {
    const { deploymentId, disclosureId } = await createDeployment(
      organization.id,
    );
    await recordVerificationCheck({
      organizationId: organization.id,
      deploymentId,
      disclosureId,
      checkWindow: windowAt(0),
      status: "success",
      failureCode: null,
      httpStatus: 200,
      widgetDetected: true,
      metadata: { widget_tags: 1 },
    });
    const archived = await ownerClient
      .from("deployments")
      .update({ status: "archived" })
      .eq("id", deploymentId);
    expect(archived.error).toBeNull();

    const page = html(await renderChecks(deploymentId));

    expect(page).toContain("no longer checked");
    // TASK-022 keeps an archived deployment's evidence, which is the reason
    // this screen has to be able to say which it is looking at.
    expect(page).toContain("Passed");
  });
});

describe("paging", () => {
  it("reaches the whole history with no row repeated and none missing", async () => {
    const { deploymentId, disclosureId } = await createDeployment(
      organization.id,
    );
    // Two pages would need 201 checks. The boundary is what matters, so this
    // asserts the link the screen builds and follows it, with the page size
    // left to TASK-026's own paging test.
    const windows: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const window = windowAt(index);
      windows.push(window.toISOString());
      await recordVerificationCheck({
        organizationId: organization.id,
        deploymentId,
        disclosureId,
        checkWindow: window,
        status: "success",
        failureCode: null,
        httpStatus: 200,
        widgetDetected: true,
        metadata: { widget_tags: 1 },
      });
    }

    const older = html(
      await renderChecks(deploymentId, { before: windows[1] }),
    );

    // Only the oldest is older than the middle window, and the cursor's own
    // row is excluded. As instants: the database spells an offset `+00:00`.
    expect(older).toContain("Older checks");
    expect(older).toContain("1 January 2021");
    expect(older).not.toContain("3 January 2021");
    expect(older).toContain("Back to the newest checks");
    // An older page explains nothing about "now": its first row is not the
    // newest check.
    expect(older).not.toContain("Most recent check");
  });

  it("shows the newest checks when the cursor cannot be read", async () => {
    const { deploymentId, disclosureId } = await createDeployment(
      organization.id,
    );
    await recordVerificationCheck({
      organizationId: organization.id,
      deploymentId,
      disclosureId,
      checkWindow: windowAt(0),
      status: "success",
      failureCode: null,
      httpStatus: 200,
      widgetDetected: true,
      metadata: { widget_tags: 1 },
    });

    for (const before of ["nonsense", "", ["a", "b"]]) {
      const page = html(await renderChecks(deploymentId, { before }));

      // The screen's own links are always well formed, so an unreadable one
      // came from somewhere else and the newest page is still the right
      // answer. The API refuses the same value, because a client asked for
      // something exact (TASK-018a's rule, TASK-026's route).
      expect(page).toContain("Most recent check");
      expect(page).not.toContain("Older checks");
    }
  });
});

describe("the deployment page's summary", () => {
  it("shows the newest check and the way to the rest", async () => {
    const { deploymentId, disclosureId } = await createDeployment(
      organization.id,
    );
    await recordVerificationCheck({
      organizationId: organization.id,
      deploymentId,
      disclosureId,
      checkWindow: windowAt(0),
      status: "failure",
      failureCode: "CONNECTION_FAILED",
      httpStatus: null,
      widgetDetected: null,
      metadata: {},
    });

    const outcome = await renderPage(() =>
      DeploymentPage({
        params: Promise.resolve({
          organizationId: organization.id,
          deploymentId,
        }),
      }),
    );
    expect(outcome.kind).toBe("rendered");
    const page = outcome.kind === "rendered" ? outcome.html : "";

    expect(page).toContain("Could not connect");
    expect(page).toContain(
      `/dashboard/${organization.id}/deployments/${deploymentId}/checks`,
    );
    // What to change is said once, on the history page, rather than in a
    // second set of words here that could drift from it.
    expect(page).not.toContain("a firewall that blocks unknown visitors");
  });

  it("says a deployment has not been checked yet, rather than nothing", async () => {
    const { deploymentId } = await createDeployment(organization.id);

    const outcome = await renderPage(() =>
      DeploymentPage({
        params: Promise.resolve({
          organizationId: organization.id,
          deploymentId,
        }),
      }),
    );
    const page = outcome.kind === "rendered" ? outcome.html : "";

    expect(page).toContain("No checks recorded yet");
  });
});
