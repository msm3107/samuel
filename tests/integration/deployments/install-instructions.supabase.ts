import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The installation section on the deployment page, against the real local
 * database (TASK-021).
 *
 * The page is rendered for real, so what is asserted is the snippet a
 * member would actually copy and the sentence they would actually read —
 * not the functions behind them, which are covered on their own in
 * tests/unit/deployments. Every readiness state is reached by doing the
 * thing that causes it: publishing, turning a notice off, archiving a
 * system, archiving the deployment.
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
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { organizationAccessOrNull } from "@/app/(dashboard)/dashboard/[organizationId]/access";
import DeploymentPage from "@/app/(dashboard)/dashboard/[organizationId]/deployments/[deploymentId]/page";
import {
  createDeploymentAction,
  setDeploymentStatusAction,
} from "@/app/(dashboard)/dashboard/[organizationId]/deployments/actions";
import { INSTALL_READINESS_MESSAGES } from "@/app/(dashboard)/dashboard/[organizationId]/deployments/messages";
import { publishDisclosureAction } from "@/app/(dashboard)/dashboard/[organizationId]/systems/[systemId]/disclosure/actions";
import {
  createAiSystemAction,
  setAiSystemStatusAction,
} from "@/app/(dashboard)/dashboard/[organizationId]/systems/actions";
import {
  ENABLED_FIELD,
  LANGUAGE_FIELD,
  MESSAGE_FIELD,
  VERSION_FIELD,
} from "@/features/disclosures/disclosure-fields";
import { readCurrentDisclosureState } from "@/features/disclosures/disclosure-queries";
import { serverEnv } from "@/lib/env/server-env";
import { actAs } from "@/tests/security/tenant-isolation/support/acting-user";
import {
  createTenantFixtures,
  type TestOrganization,
  type TestUser,
} from "@/tests/security/tenant-isolation/support/tenants";
import { renderPage, runAction } from "@/tests/support/next-interrupts";

const fixtures = createTenantFixtures();

let member: TestUser;
let org: TestOrganization;

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    data.append(name, value);
  }
  return data;
}

async function registerSystem(organizationId = org.id): Promise<string> {
  const outcome = await runAction(() =>
    createAiSystemAction(
      organizationId,
      null,
      form({
        name: `System ${randomUUID().slice(0, 8)}`,
        systemType: "chatbot",
        provider: "",
        description: "",
      }),
    ),
  );
  if (outcome.kind !== "redirect") {
    throw new Error(`system not registered: ${JSON.stringify(outcome)}`);
  }
  return outcome.location.split("/").at(-1) ?? "";
}

async function registerDeployment(systemId: string): Promise<string> {
  const outcome = await runAction(() =>
    createDeploymentAction(
      org.id,
      systemId,
      null,
      form({ hostname: `i${randomUUID().slice(0, 8)}.example.com` }),
    ),
  );
  if (outcome.kind !== "redirect") {
    throw new Error(`deployment not registered: ${JSON.stringify(outcome)}`);
  }
  return outcome.location.split("/").at(-1) ?? "";
}

async function publish(
  systemId: string,
  options: {
    enabled?: boolean;
    expectedVersion?: number;
    organizationId?: string;
  } = {},
): Promise<void> {
  const values: Record<string, string> = {
    [MESSAGE_FIELD]: `You are interacting with an AI system. ${randomUUID().slice(0, 8)}`,
    [LANGUAGE_FIELD]: "en",
  };
  if (options.enabled ?? true) {
    values[ENABLED_FIELD] = "on";
  }
  if (options.expectedVersion !== undefined) {
    values[VERSION_FIELD] = String(options.expectedVersion);
  }
  const outcome = await runAction(() =>
    publishDisclosureAction(
      options.organizationId ?? org.id,
      systemId,
      null,
      form(values),
    ),
  );
  if (
    outcome.kind !== "returned" ||
    (outcome.value as { result?: string } | null)?.result !== "published"
  ) {
    throw new Error(`not published: ${JSON.stringify(outcome)}`);
  }
}

async function pageHtml(deploymentId: string): Promise<string> {
  const outcome = await renderPage(() =>
    DeploymentPage({
      params: Promise.resolve({ organizationId: org.id, deploymentId }),
    }),
  );
  if (outcome.kind !== "rendered") {
    throw new Error(`page not rendered: ${JSON.stringify(outcome)}`);
  }
  return outcome.html;
}

/**
 * Just the installation section. The page around it carries the
 * organization's and the AI system's identifiers in its own breadcrumbs and
 * links — they are in the address bar too — so the promise that only a
 * public identifier is shown is a promise about this section.
 */
function installSection(html: string): string {
  const start = html.indexOf('aria-labelledby="install-heading"');
  expect(start, "the installation section was not rendered").toBeGreaterThan(
    -1,
  );
  const end = html.indexOf("</section>", start);
  return html.slice(start, end);
}

/** HTML-escaped, as the rendered snippet appears in the markup. */
function escaped(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function publicIdOf(deploymentId: string): Promise<string> {
  const { data } = await fixtures.admin
    .from("deployments")
    .select("public_id")
    .eq("id", deploymentId)
    .single();
  return (data as { public_id: string }).public_id;
}

beforeAll(async () => {
  member = await fixtures.createUser();
  const client = await fixtures.signedInClient(member);
  const owner = await fixtures.createUser();
  org = await fixtures.createOrganization({ ownerId: owner.id });
  await fixtures.addMember(org.id, member.id, "member");
  actAs(member, client);
}, 30_000);

afterAll(async () => {
  await fixtures.cleanup();
});

describe("the installation section", () => {
  it("shows the tag a customer pastes, for this deployment and this host", async () => {
    const systemId = await registerSystem();
    const deploymentId = await registerDeployment(systemId);
    await publish(systemId);
    const publicId = await publicIdOf(deploymentId);

    const html = await pageHtml(deploymentId);

    const appUrl = serverEnv().NEXT_PUBLIC_APP_URL;
    expect(html).toContain(
      escaped(`src="${new URL("/widget.js", appUrl).toString()}"`),
    );
    expect(html).toContain(escaped(`data-deployment="${publicId}"`));
    expect(html).toContain(escaped(`data-target="#site-footer"`));
    // Both policy entries, on the same host as the script above them.
    const { origin } = new URL(appUrl);
    expect(html).toContain(`script-src ${origin}`);
    expect(html).toContain(`connect-src ${origin}`);
    expect(html).toContain(INSTALL_READINESS_MESSAGES.live);
  });

  it("puts no database identifier in the installation", async () => {
    const systemId = await registerSystem();
    const deploymentId = await registerDeployment(systemId);
    await publish(systemId);

    const section = installSection(await pageHtml(deploymentId));

    // Not the deployment's own UUID, not its system's, not its
    // organization's — and no other, since the shape is what is asserted
    // rather than the three that happen to be at hand.
    for (const id of [deploymentId, systemId, org.id]) {
      expect(section).not.toContain(id);
    }
    expect(section).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    );
  });

  it("says a system that has never published shows nothing yet", async () => {
    const systemId = await registerSystem();
    const deploymentId = await registerDeployment(systemId);

    const html = await pageHtml(deploymentId);

    expect(html).toContain(INSTALL_READINESS_MESSAGES.never_published);
    // Still installable: the tag is correct before anything is published.
    expect(html).toContain(escaped(`data-deployment="`));
    expect(html).toContain(
      `/dashboard/${org.id}/systems/${systemId}/disclosure`,
    );
  });

  it("says a notice that was turned off is not showing", async () => {
    const systemId = await registerSystem();
    const deploymentId = await registerDeployment(systemId);
    await publish(systemId);
    await publish(systemId, { enabled: false, expectedVersion: 1 });

    const html = await pageHtml(deploymentId);

    expect(html).toContain(INSTALL_READINESS_MESSAGES.disabled);
    expect(html).not.toContain(INSTALL_READINESS_MESSAGES.live);
    // The version said is the current one, not the enabled one below it.
    expect(html).toContain("Version 2 is the current one.");
  });

  it("says an archived system, and an archived deployment, each in turn", async () => {
    const systemId = await registerSystem();
    const deploymentId = await registerDeployment(systemId);
    await publish(systemId);

    await runAction(() =>
      setAiSystemStatusAction(org.id, systemId, "archived", null, form({})),
    );
    expect(await pageHtml(deploymentId)).toContain(
      INSTALL_READINESS_MESSAGES.system_archived,
    );

    // Archived under an archived system: the page is about the deployment,
    // and its restore control is the one on this screen.
    await runAction(() =>
      setDeploymentStatusAction(
        org.id,
        deploymentId,
        "archived",
        null,
        form({}),
      ),
    );
    const html = await pageHtml(deploymentId);
    expect(html).toContain(INSTALL_READINESS_MESSAGES.deployment_archived);
    expect(html).not.toContain(INSTALL_READINESS_MESSAGES.system_archived);
  });
});

describe("the current version behind it", () => {
  /** A real access object, made the way the page makes one. */
  async function accessToMine() {
    const access = await organizationAccessOrNull(org.id, "organization.read");
    if (access === null) {
      throw new Error("the acting member has no access to their own org");
    }
    return access;
  }

  it("is the newest version's enabled, not an older enabled one", async () => {
    const systemId = await registerSystem();
    await publish(systemId);

    expect(
      await readCurrentDisclosureState(await accessToMine(), systemId),
    ).toEqual({ version: 1, enabled: true });

    await publish(systemId, { enabled: false, expectedVersion: 1 });

    expect(
      await readCurrentDisclosureState(await accessToMine(), systemId),
    ).toEqual({ version: 2, enabled: false });
  });

  it("is nothing for a system with no versions", async () => {
    const systemId = await registerSystem();

    expect(
      await readCurrentDisclosureState(await accessToMine(), systemId),
    ).toBeNull();
  });

  it("is nothing for another organization's system, through RLS", async () => {
    // Their system, published and enabled, set up as them.
    const theirOwner = await fixtures.createUser();
    const theirs = await fixtures.createOrganization({
      ownerId: theirOwner.id,
    });
    actAs(theirOwner, await fixtures.signedInClient(theirOwner));
    const theirSystem = await registerSystem(theirs.id);
    await publish(theirSystem, { organizationId: theirs.id });

    // Read with this organization's access: the query filters by
    // organization and row-level security refuses the row underneath, so a
    // system that exists and is showing a notice is indistinguishable from
    // one that does not exist.
    actAs(member, await fixtures.signedInClient(member));
    expect(
      await readCurrentDisclosureState(await accessToMine(), theirSystem),
    ).toBeNull();
  });
});
