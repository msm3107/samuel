import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The dashboard's deployment screens against the real local database
 * (TASK-015): what a member does from the system and deployment pages, end
 * to end below the browser. Isolation is in tests/security/deployments.
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

import {
  createDeploymentAction,
  setDeploymentStatusAction,
} from "@/app/(dashboard)/dashboard/[organizationId]/deployments/actions";
import DeploymentPage from "@/app/(dashboard)/dashboard/[organizationId]/deployments/[deploymentId]/page";
import {
  createAiSystemAction,
  setAiSystemStatusAction,
} from "@/app/(dashboard)/dashboard/[organizationId]/systems/actions";
import AiSystemPage from "@/app/(dashboard)/dashboard/[organizationId]/systems/[systemId]/page";
import { renderPage, runAction } from "@/tests/support/next-interrupts";
import { actAs } from "@/tests/security/tenant-isolation/support/acting-user";
import {
  createTenantFixtures,
  type TestOrganization,
  type TestUser,
} from "@/tests/security/tenant-isolation/support/tenants";

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

function deploymentForm(hostname: string) {
  return form({ hostname });
}

function hostname(label: string): string {
  return `${label}-${randomUUID().slice(0, 8)}.example.com`;
}

async function registerSystem(name = `System ${randomUUID().slice(0, 8)}`) {
  const outcome = await runAction(() =>
    createAiSystemAction(
      org.id,
      null,
      form({ name, systemType: "chatbot", provider: "", description: "" }),
    ),
  );
  if (outcome.kind !== "redirect") {
    throw new Error(`system not registered: ${JSON.stringify(outcome)}`);
  }
  return outcome.location.split("/").at(-1) ?? "";
}

async function setSystemStatus(id: string, status: string) {
  return runAction(() =>
    setAiSystemStatusAction(org.id, id, status, null, form({})),
  );
}

async function register(systemId: string, host: string) {
  return runAction(() =>
    createDeploymentAction(org.id, systemId, null, deploymentForm(host)),
  );
}

async function registered(systemId: string, host: string) {
  const outcome = await register(systemId, host);
  if (outcome.kind !== "redirect") {
    throw new Error(`deployment not registered: ${JSON.stringify(outcome)}`);
  }
  return outcome.location.split("/").at(-1) ?? "";
}

async function setStatus(id: string, status: string) {
  return runAction(() =>
    setDeploymentStatusAction(org.id, id, status, null, form({})),
  );
}

async function row(id: string) {
  const { data } = await fixtures.admin
    .from("deployments")
    .select("organization_id, ai_system_id, hostname, status, public_id")
    .eq("id", id)
    .single();
  return data;
}

async function systemPageHtml(systemId: string) {
  const outcome = await renderPage(() =>
    AiSystemPage({
      params: Promise.resolve({ organizationId: org.id, systemId }),
    }),
  );
  if (outcome.kind !== "rendered") {
    throw new Error(`system page not rendered: ${JSON.stringify(outcome)}`);
  }
  return outcome.html;
}

async function deploymentPageHtml(deploymentId: string) {
  const outcome = await renderPage(() =>
    DeploymentPage({
      params: Promise.resolve({ organizationId: org.id, deploymentId }),
    }),
  );
  if (outcome.kind !== "rendered") {
    throw new Error(`deployment page not rendered: ${JSON.stringify(outcome)}`);
  }
  return outcome.html;
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

describe("a member, from the dashboard", () => {
  it("registers a hostname and is taken to the new deployment", async () => {
    const systemId = await registerSystem();
    const suffix = randomUUID().slice(0, 8);
    // "bücher.de" typed with a mix of case, stored as its punycode form.
    const typed = `shop-${suffix}.Bücher.DE`;
    const expectedHostname = `shop-${suffix}.xn--bcher-kva.de`;

    const outcome = await register(systemId, typed);

    expect(outcome.kind).toBe("redirect");
    const id =
      outcome.kind === "redirect"
        ? (outcome.location.split("/").at(-1) ?? "")
        : "";
    expect(outcome).toEqual({
      kind: "redirect",
      location: `/dashboard/${org.id}/deployments/${id}`,
    });
    const stored = await row(id);
    expect(stored).toMatchObject({
      organization_id: org.id,
      ai_system_id: systemId,
      hostname: expectedHostname,
      status: "active",
    });
    expect(stored?.public_id).toMatch(/^dep_[a-z2-7]{26}$/);
  });

  it.each([
    ["", "hostname_invalid"],
    ["ftp://a.com", "hostname_scheme_not_allowed"],
    ["https://u:p@a.com", "hostname_credentials_not_allowed"],
    ["localhost", "hostname_private_network"],
    ["8.8.8.8", "hostname_ip_address_not_allowed"],
    ["a.com:8080", "hostname_port_not_allowed"],
    ["https://a.com/x", "hostname_path_not_allowed"],
  ] as const)(
    "refuses %s as %s, and echoes what was typed",
    async (typed, code) => {
      const systemId = await registerSystem();

      const outcome = await register(systemId, typed);

      expect(outcome).toEqual({
        kind: "returned",
        value: { result: code, value: typed },
      });
    },
  );

  it("already registered under the same system is refused as exists", async () => {
    const systemId = await registerSystem();
    const host = hostname("dup");
    await registered(systemId, host);

    const outcome = await register(systemId, host);

    expect(outcome).toEqual({
      kind: "returned",
      value: { result: "exists", value: host },
    });
  });

  it("the same hostname on a different system is fine", async () => {
    const systemId = await registerSystem();
    const otherSystemId = await registerSystem();
    const host = hostname("shared");
    await registered(systemId, host);

    const outcome = await register(otherSystemId, host);

    expect(outcome.kind).toBe("redirect");
  });

  it("registering under an archived system is refused as ai_system_archived", async () => {
    const systemId = await registerSystem();
    await setSystemStatus(systemId, "archived");
    const host = hostname("under-archived");

    const outcome = await register(systemId, host);

    expect(outcome).toEqual({
      kind: "returned",
      value: { result: "ai_system_archived", value: host },
    });
  });

  it("archives a deployment", async () => {
    const systemId = await registerSystem();
    const id = await registered(systemId, hostname("to-archive"));

    const outcome = await setStatus(id, "archived");

    expect(outcome).toEqual({
      kind: "returned",
      value: { result: "archived" },
    });
    expect((await row(id))?.status).toBe("archived");
  });

  it("restores a deployment, with the same public ID", async () => {
    const systemId = await registerSystem();
    const id = await registered(systemId, hostname("to-restore"));
    const publicId = (await row(id))?.public_id;
    await setStatus(id, "archived");

    const outcome = await setStatus(id, "active");

    expect(outcome).toEqual({
      kind: "returned",
      value: { result: "restored" },
    });
    const after = await row(id);
    expect(after?.status).toBe("active");
    expect(after?.public_id).toBe(publicId);
  });

  it("restoring under an archived system is refused as ai_system_archived", async () => {
    const systemId = await registerSystem();
    const id = await registered(systemId, hostname("restore-under-archived"));
    await setStatus(id, "archived");
    await setSystemStatus(systemId, "archived");

    const outcome = await setStatus(id, "active");

    expect(outcome).toEqual({
      kind: "returned",
      value: { result: "ai_system_archived" },
    });
    expect((await row(id))?.status).toBe("archived");
  });

  it("restoring into a hostname another active deployment now holds is refused as exists", async () => {
    const systemId = await registerSystem();
    const host = hostname("taken-on-restore");
    const first = await registered(systemId, host);
    await setStatus(first, "archived");
    // The hostname is free again while the first is archived.
    await registered(systemId, host);

    const outcome = await setStatus(first, "active");

    expect(outcome).toEqual({
      kind: "returned",
      value: { result: "exists" },
    });
    expect((await row(first))?.status).toBe("archived");
  });

  it("the deployment page shows the public ID and both hostname forms for an IDN", async () => {
    const systemId = await registerSystem();
    const suffix = randomUUID().slice(0, 8);
    const host = `shop-${suffix}.bücher.de`;
    const id = await registered(systemId, host);
    const publicId = (await row(id))?.public_id ?? "";

    const html = await deploymentPageHtml(id);

    expect(html).toContain(publicId);
    // Both the Unicode reading form and the stored ASCII (punycode) form.
    expect(html).toContain(`shop-${suffix}.bücher.de`);
    expect(html).toContain(`shop-${suffix}.xn--bcher-kva.de`);
  });

  it("the deployment page says Inactive when its AI system is archived", async () => {
    const systemId = await registerSystem();
    const id = await registered(systemId, hostname("inactive-system"));
    await setSystemStatus(systemId, "archived");

    const html = await deploymentPageHtml(id);

    expect(html).toContain("Inactive");
  });

  it("the system page lists its deployments, and marks them inactive when the system is archived", async () => {
    const systemId = await registerSystem();
    const host = hostname("listed");
    await registered(systemId, host);

    const before = await systemPageHtml(systemId);
    expect(before).toContain(host);
    expect(before).not.toContain("(inactive)");

    await setSystemStatus(systemId, "archived");
    const after = await systemPageHtml(systemId);
    expect(after).toContain(host);
    expect(after).toContain("(inactive)");
  });
});
