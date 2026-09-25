import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * README §8's isolation checks for the disclosure screen's action, against
 * the real local database (TASK-018): user A cannot publish under
 * organization B or B's systems, through either organization's ID; a viewer
 * of A's own organization cannot publish; smuggled form fields naming
 * another organization or system are ignored; and nothing returned to the
 * caller carries a database code, hint, SQL or a stack trace.
 * disclosures-api.supabase.ts (TASK-017) proves the same boundary for the
 * API route; this proves the dashboard's action adds no way around it.
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

import type { SupabaseClient } from "@supabase/supabase-js";

import { publishDisclosureAction } from "@/app/(dashboard)/dashboard/[organizationId]/systems/[systemId]/disclosure/actions";
import DisclosurePage from "@/app/(dashboard)/dashboard/[organizationId]/systems/[systemId]/disclosure/page";
import { createAiSystemAction } from "@/app/(dashboard)/dashboard/[organizationId]/systems/actions";
import {
  ENABLED_FIELD,
  LANGUAGE_FIELD,
  MESSAGE_FIELD,
} from "@/features/disclosures/disclosure-fields";
import { actAs } from "@/tests/security/tenant-isolation/support/acting-user";
import {
  createTenantFixtures,
  type TestOrganization,
  type TestUser,
} from "@/tests/security/tenant-isolation/support/tenants";
import { renderPage, runAction } from "@/tests/support/next-interrupts";

const fixtures = createTenantFixtures();

let userA: TestUser;
let clientA: SupabaseClient;
let orgA: TestOrganization;
let systemA: string;

let userB: TestUser;
let clientB: SupabaseClient;
let orgB: TestOrganization;
/** Has a published version. */
let systemBWithHistory: string;
/** Never published: the refusal must not depend on there being history. */
let systemBWithoutHistory: string;

let viewerOfA: TestUser;
let viewerClient: SupabaseClient;

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

function disclosureForm(text: string, extra: Record<string, string> = {}) {
  return form({
    [MESSAGE_FIELD]: text,
    [LANGUAGE_FIELD]: "en",
    [ENABLED_FIELD]: "on",
    ...extra,
  });
}

async function createSystemAs(
  user: TestUser,
  client: SupabaseClient,
  organizationId: string,
): Promise<string> {
  actAs(user, client);
  const outcome = await runAction(() =>
    createAiSystemAction(
      organizationId,
      null,
      form({
        name: `Sys ${randomUUID().slice(0, 8)}`,
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

async function publishAs(
  user: TestUser,
  client: SupabaseClient,
  organizationId: string,
  systemId: string,
  formData: FormData = disclosureForm(message("Notice")),
) {
  actAs(user, client);
  return runAction(() =>
    publishDisclosureAction(organizationId, systemId, null, formData),
  );
}

async function currentDisclosure(systemId: string) {
  const { data } = await fixtures.admin
    .from("disclosures")
    .select("id, version, message, organization_id, ai_system_id")
    .eq("ai_system_id", systemId)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data;
}

beforeAll(async () => {
  userA = await fixtures.createUser();
  clientA = await fixtures.signedInClient(userA);
  orgA = await fixtures.createOrganization({ ownerId: userA.id });
  systemA = await createSystemAs(userA, clientA, orgA.id);

  userB = await fixtures.createUser();
  clientB = await fixtures.signedInClient(userB);
  orgB = await fixtures.createOrganization({ ownerId: userB.id });

  systemBWithHistory = await createSystemAs(userB, clientB, orgB.id);
  const published = await publishAs(
    userB,
    clientB,
    orgB.id,
    systemBWithHistory,
    disclosureForm(message("B's notice")),
  );
  if (
    published.kind !== "returned" ||
    (published.value as { result?: string } | null)?.result !== "published"
  ) {
    throw new Error(`setup publish failed: ${JSON.stringify(published)}`);
  }

  systemBWithoutHistory = await createSystemAs(userB, clientB, orgB.id);

  viewerOfA = await fixtures.createUser();
  await fixtures.addMember(orgA.id, viewerOfA.id, "viewer");
  viewerClient = await fixtures.signedInClient(viewerOfA);
}, 30_000);

afterAll(async () => {
  await fixtures.cleanup();
});

describe("user A and organization B's systems", () => {
  it("cannot publish under B's system through A's own organization: ai_system_not_found, whether or not B's system has history", async () => {
    for (const systemId of [systemBWithHistory, systemBWithoutHistory]) {
      const outcome = await publishAs(
        userA,
        clientA,
        orgA.id,
        systemId,
        disclosureForm(message("Planted")),
      );

      expect(outcome).toEqual({
        kind: "returned",
        value: expect.objectContaining({ result: "ai_system_not_found" }),
      });
    }
  });

  it("cannot publish under B's system through B's own organization: not_permitted, the same whether or not B's system has history", async () => {
    for (const systemId of [systemBWithHistory, systemBWithoutHistory]) {
      const outcome = await publishAs(
        userA,
        clientA,
        orgB.id,
        systemId,
        disclosureForm(message("Planted")),
      );

      expect(outcome).toEqual({
        kind: "returned",
        value: expect.objectContaining({ result: "not_permitted" }),
      });
    }
  });

  it("nothing of B's is written by any of the refused attempts", async () => {
    const before = await currentDisclosure(systemBWithHistory);

    await publishAs(
      userA,
      clientA,
      orgA.id,
      systemBWithHistory,
      disclosureForm(message("Should never land")),
    );
    await publishAs(
      userA,
      clientA,
      orgB.id,
      systemBWithHistory,
      disclosureForm(message("Should never land either")),
    );

    const after = await currentDisclosure(systemBWithHistory);
    expect(after).toEqual(before);
  });
});

describe("a viewer of organization A", () => {
  it("is refused not_permitted, and nothing is stored", async () => {
    const before = await currentDisclosure(systemA);

    const outcome = await publishAs(
      viewerOfA,
      viewerClient,
      orgA.id,
      systemA,
      disclosureForm(message("Should not land")),
    );

    expect(outcome).toEqual({
      kind: "returned",
      value: expect.objectContaining({ result: "not_permitted" }),
    });
    expect(await currentDisclosure(systemA)).toEqual(before);
  });
});

describe("smuggled form fields", () => {
  it("an organization and system named in the form are ignored: the write lands on the bound ones", async () => {
    const text = message("Smuggled");

    const outcome = await publishAs(
      userA,
      clientA,
      orgA.id,
      systemA,
      disclosureForm(text, {
        organizationId: orgB.id,
        aiSystemId: systemBWithHistory,
        id: randomUUID(),
        version: "999",
        createdBy: userB.id,
        createdAt: "2026-01-01T00:00:00Z",
      }),
    );

    expect(outcome).toMatchObject({
      kind: "returned",
      value: { result: "published" },
    });
    const row = await currentDisclosure(systemA);
    expect(row).toMatchObject({
      organization_id: orgA.id,
      ai_system_id: systemA,
      message: text,
    });
    // Never written under B's system, whatever the form claimed.
    const bRow = await currentDisclosure(systemBWithHistory);
    expect(bRow?.message).not.toBe(text);
  });
});

describe("error states never carry database internals", () => {
  const FORBIDDEN_PATTERNS = [
    /\b(23503|23505|23514|42501)\b/, // Postgres SQLSTATE codes this layer maps
    /PT409/, // the custom "changed"/"unchanged" hint code
    /\bhint\b/i,
    /\bconstraint\b/i,
    /\bat\s+.+\.(ts|js):\d+/, // a stack trace frame
  ];

  function assertNoLeak(value: unknown) {
    const text = JSON.stringify(value);
    for (const pattern of FORBIDDEN_PATTERNS) {
      expect(text).not.toMatch(pattern);
    }
  }

  it("a not_permitted refusal carries no database internals", async () => {
    const outcome = await publishAs(
      viewerOfA,
      viewerClient,
      orgA.id,
      systemA,
      disclosureForm(message("Refused")),
    );
    assertNoLeak(outcome.kind === "returned" ? outcome.value : outcome);
  });

  it("an ai_system_not_found refusal carries no database internals", async () => {
    const outcome = await publishAs(
      userA,
      clientA,
      orgA.id,
      systemBWithHistory,
      disclosureForm(message("Refused")),
    );
    assertNoLeak(outcome.kind === "returned" ? outcome.value : outcome);
  });
});

/**
 * The history cursor (TASK-018a). It narrows rows the caller can already
 * read, so it must not widen anything: a system in another organization is
 * the same "not found" with a cursor as without one, whatever that system
 * has published and whatever page the cursor names.
 */
describe("the history cursor and another organization's system", () => {
  async function pageAs(
    user: TestUser,
    client: SupabaseClient,
    organizationId: string,
    systemId: string,
    searchParams: Record<string, string | string[] | undefined>,
  ) {
    actAs(user, client);
    return renderPage(() =>
      DisclosurePage({
        params: Promise.resolve({ organizationId, systemId }),
        searchParams: Promise.resolve(searchParams),
      }),
    );
  }

  it("is not found under A's own organization, cursor or no cursor", async () => {
    for (const systemId of [systemBWithHistory, systemBWithoutHistory]) {
      for (const searchParams of [{}, { before: "1" }, { before: "2" }]) {
        const outcome = await pageAs(
          userA,
          clientA,
          orgA.id,
          systemId,
          searchParams,
        );

        expect(outcome).toEqual({ kind: "not_found" });
      }
    }
  });

  it("is not found under B's own organization, cursor or no cursor", async () => {
    for (const searchParams of [{}, { before: "2" }]) {
      const outcome = await pageAs(
        userA,
        clientA,
        orgB.id,
        systemBWithHistory,
        searchParams,
      );

      expect(outcome).toEqual({ kind: "not_found" });
    }
  });

  it("shows a viewer of A their own system's pages, with no editor", async () => {
    const outcome = await pageAs(viewerOfA, viewerClient, orgA.id, systemA, {
      before: "2",
    });

    expect(outcome.kind).toBe("rendered");
    if (outcome.kind !== "rendered") {
      return;
    }
    expect(outcome.html).not.toContain("<textarea");
    expect(outcome.html).toContain("Back to the newest versions");
  });
});
