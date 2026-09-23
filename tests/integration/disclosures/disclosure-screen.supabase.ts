import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The dashboard's disclosure screen against the real local database
 * (TASK-018): what a member does from the AI system page and the disclosure
 * screen — publishing a first notice, a second version, turning it off, a
 * stale publish, an unchanged publish, a publish under an archived system —
 * and the order the history comes back in. Isolation is in
 * tests/security/disclosures/disclosure-screen.supabase.ts.
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

import { publishDisclosureAction } from "@/app/(dashboard)/dashboard/[organizationId]/systems/[systemId]/disclosure/actions";
import DisclosurePage from "@/app/(dashboard)/dashboard/[organizationId]/systems/[systemId]/disclosure/page";
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

function message(label: string): string {
  return `${label} ${randomUUID().slice(0, 8)}.`;
}

/**
 * `enabled` present means checked, as a real checkbox's submission works:
 * omit it from `overrides` to leave it unchecked.
 */
function disclosureForm(fields: {
  message: string;
  language?: string;
  enabled?: boolean;
  expectedVersion?: number;
}): FormData {
  const values: Record<string, string> = {
    [MESSAGE_FIELD]: fields.message,
    [LANGUAGE_FIELD]: fields.language ?? "en",
  };
  if (fields.enabled ?? true) {
    values[ENABLED_FIELD] = "on";
  }
  if (fields.expectedVersion !== undefined) {
    values[VERSION_FIELD] = String(fields.expectedVersion);
  }
  return form(values);
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

async function publish(
  systemId: string,
  fields: Parameters<typeof disclosureForm>[0],
) {
  return runAction(() =>
    publishDisclosureAction(org.id, systemId, null, disclosureForm(fields)),
  );
}

/** Publishes and returns the new version, throwing if it was refused. */
async function published(
  systemId: string,
  fields: Parameters<typeof disclosureForm>[0],
): Promise<number> {
  const outcome = await publish(systemId, fields);
  if (
    outcome.kind !== "returned" ||
    (outcome.value as { result?: string } | null)?.result !== "published"
  ) {
    throw new Error(`not published: ${JSON.stringify(outcome)}`);
  }
  return (outcome.value as { version: number }).version;
}

async function disclosurePageHtml(systemId: string) {
  const outcome = await renderPage(() =>
    DisclosurePage({
      params: Promise.resolve({ organizationId: org.id, systemId }),
    }),
  );
  if (outcome.kind !== "rendered") {
    throw new Error(`page not rendered: ${JSON.stringify(outcome)}`);
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

describe("a member, publishing from the dashboard", () => {
  it("a first publish, sending no version field, becomes version 1", async () => {
    const systemId = await registerSystem();

    const outcome = await publish(systemId, { message: message("First") });

    expect(outcome).toEqual({
      kind: "returned",
      value: expect.objectContaining({ result: "published", version: 1 }),
    });
  });

  it("a second publish naming version 1 becomes version 2", async () => {
    const systemId = await registerSystem();
    const v1 = await published(systemId, { message: message("V1") });
    expect(v1).toBe(1);

    const outcome = await publish(systemId, {
      message: message("V2"),
      expectedVersion: v1,
    });

    expect(outcome).toEqual({
      kind: "returned",
      value: expect.objectContaining({ result: "published", version: 2 }),
    });
  });

  it("unchecking enabled publishes a further version with enabled false", async () => {
    const systemId = await registerSystem();
    const text = message("On then off");
    const v1 = await published(systemId, { message: text });

    const outcome = await publish(systemId, {
      message: text,
      enabled: false,
      expectedVersion: v1,
    });

    expect(outcome).toEqual({
      kind: "returned",
      value: expect.objectContaining({
        result: "published",
        version: v1 + 1,
        values: expect.objectContaining({ enabled: false }),
      }),
    });
  });

  it("a publish naming an older version is refused disclosure_changed", async () => {
    const systemId = await registerSystem();
    const v1 = await published(systemId, { message: message("V1") });
    await published(systemId, { message: message("V2"), expectedVersion: v1 });

    const stale = await publish(systemId, {
      message: message("Stale"),
      expectedVersion: v1,
    });

    expect(stale).toEqual({
      kind: "returned",
      value: expect.objectContaining({ result: "disclosure_changed" }),
    });
  });

  it("republishing the current values unchanged is refused disclosure_unchanged", async () => {
    const systemId = await registerSystem();
    const text = message("Same");
    const v1 = await published(systemId, { message: text, language: "en" });

    const again = await publish(systemId, {
      message: text,
      language: "en",
      expectedVersion: v1,
    });

    expect(again).toEqual({
      kind: "returned",
      value: expect.objectContaining({ result: "disclosure_unchanged" }),
    });
  });

  it("a publish under an archived AI system is refused ai_system_archived", async () => {
    const systemId = await registerSystem();
    await setSystemStatus(systemId, "archived");

    const outcome = await publish(systemId, { message: message("Blocked") });

    expect(outcome).toEqual({
      kind: "returned",
      value: expect.objectContaining({ result: "ai_system_archived" }),
    });
  });

  it("the history the page reads is newest-first, with the current version marked first", async () => {
    const systemId = await registerSystem();
    const v1 = await published(systemId, { message: message("Oldest") });
    const v2 = await published(systemId, {
      message: message("Middle"),
      expectedVersion: v1,
    });
    const v3 = await published(systemId, {
      message: message("Newest"),
      expectedVersion: v2,
    });
    expect([v1, v2, v3]).toEqual([1, 2, 3]);

    const html = await disclosurePageHtml(systemId);

    const positionOf = (needle: string) => html.indexOf(needle);
    expect(positionOf("Version 3")).toBeGreaterThanOrEqual(0);
    expect(positionOf("Version 3")).toBeLessThan(positionOf("Version 2"));
    expect(positionOf("Version 2")).toBeLessThan(positionOf("Version 1"));
    // The "Current" marker sits in the first (newest) entry, before the
    // second entry's heading.
    expect(positionOf("Version 3")).toBeLessThan(positionOf("Current"));
    expect(positionOf("Current")).toBeLessThan(positionOf("Version 2"));
  });
});
