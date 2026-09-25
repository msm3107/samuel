import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * What the disclosure screen does with a cursor (TASK-018a), with the
 * session and the database faked, so the page boundary can be reached
 * without publishing two hundred versions.
 *
 * The invariant this suite guards is the owner's decision of 2026-09-25: a
 * paged view renders no editor at all, so nothing on it can publish against
 * a version that is not the current one. It also pins that a cursor the page
 * cannot read never reaches a query as anything but "no cursor".
 */
const calls = vi.hoisted(() => ({
  role: "member" as string,
  status: "active" as string,
  /** Every version the system has, newest first. */
  versions: [] as number[],
  /** What the query layer asked the database to bound by, if anything. */
  cursor: undefined as number | undefined,
  /** One more than the page size: what the query asks the database for. */
  fetchLimit: 201,
}));

vi.mock("@/lib/auth/require-session", () => ({
  requireSession: async () => ({ userId: USER }),
  requireDashboardSession: async () => ({ userId: USER }),
}));

vi.mock("@/lib/auth/require-organization-role", () => ({
  requireOrganizationPermission: async ({
    organizationId,
  }: {
    organizationId: string;
  }) => ({ userId: USER, organizationId, role: calls.role }),
}));

vi.mock("@/features/organizations/organization-queries", () => ({
  readOrganization: async () => ({
    id: ORG,
    name: "Acme",
    slug: "acme",
    createdAt: "2026-09-01T00:00:00+00:00",
  }),
}));

vi.mock("@/features/ai-systems/ai-system-queries", () => ({
  readAiSystem: async () => ({
    id: SYSTEM,
    name: "Support bot",
    systemType: "chatbot",
    status: calls.status,
  }),
}));

/**
 * Only the history query reaches the database here, so the whole client is
 * one chain. It answers as Postgres would: the versions below the cursor,
 * newest first, at most one more than a page.
 */
vi.mock("@/lib/database/session-client", () => {
  type Chain = {
    select: () => Chain;
    eq: () => Chain;
    order: () => Chain;
    limit: () => Chain;
    lt: (column: string, value: unknown) => Chain;
    maybeSingle: () => Promise<{ data: unknown; error: null }>;
  };
  const chain: Chain = {
    select: () => chain,
    eq: () => chain,
    order: () => chain,
    limit: () => chain,
    lt: (_column, value) => {
      calls.cursor = value as number;
      return chain;
    },
    maybeSingle: async () => ({
      data: {
        status: calls.status,
        disclosures: calls.versions
          .filter((v) => calls.cursor === undefined || v < calls.cursor)
          .slice(0, calls.fetchLimit)
          .map((version) => ({
            id: `00000000-0000-4000-8000-${String(version).padStart(12, "0")}`,
            version,
            message: `Notice ${version}.`,
            language: "en",
            enabled: true,
            created_at: "2026-09-20T09:00:00+00:00",
            created_by: USER,
          })),
      },
      error: null,
    }),
  };
  return {
    createResolvingSessionClient: async () => ({
      supabase: { from: () => chain },
    }),
  };
});

import DisclosurePage from "@/app/(dashboard)/dashboard/[organizationId]/systems/[systemId]/disclosure/page";
import { DISCLOSURE_LIST_LIMIT } from "@/features/disclosures/disclosure-queries";
import { renderPage } from "@/tests/support/next-interrupts";

const USER = "5b0e8d1a-2c4f-4e6a-9b8c-7d1e2f3a4b5c";
const ORG = "0f6b2a4c-8d1e-4f3a-9b5c-6e7d8a9b0c1d";
const SYSTEM = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

calls.fetchLimit = DISCLOSURE_LIST_LIMIT + 1;

/** `count` versions, newest first, as the history comes back. */
function versions(count: number): number[] {
  return Array.from({ length: count }, (_, index) => count - index);
}

async function render(
  searchParams: Record<string, string | string[] | undefined> = {},
) {
  const outcome = await renderPage(() =>
    DisclosurePage({
      params: Promise.resolve({ organizationId: ORG, systemId: SYSTEM }),
      searchParams: Promise.resolve(searchParams),
    }),
  );
  if (outcome.kind !== "rendered") {
    throw new Error(`page not rendered: ${JSON.stringify(outcome)}`);
  }
  return outcome.html;
}

const olderLink = (before: number) =>
  `/dashboard/${ORG}/systems/${SYSTEM}/disclosure?before=${before}`;

beforeEach(() => {
  calls.role = "member";
  calls.status = "active";
  calls.versions = [];
  calls.cursor = undefined;
});

describe("the link to older versions", () => {
  it(`a history of exactly ${DISCLOSURE_LIST_LIMIT} offers no older page`, async () => {
    calls.versions = versions(DISCLOSURE_LIST_LIMIT);

    const html = await render();

    expect(html).not.toContain("Older versions");
    expect(html).not.toContain("?before=");
  });

  it("one more than a page offers an older page, starting below the last shown", async () => {
    calls.versions = versions(DISCLOSURE_LIST_LIMIT + 1);

    const html = await render();

    expect(html).toContain("Older versions");
    // The last row of the page is version 1 above the oldest, so the cursor
    // is exactly that: nothing is repeated and nothing is skipped.
    expect(html).toContain(olderLink(2));
  });

  it("the cursor of the next page is the last version this one showed", async () => {
    calls.versions = versions(DISCLOSURE_LIST_LIMIT * 2);

    const html = await render();

    expect(html).toContain(olderLink(DISCLOSURE_LIST_LIMIT + 1));
  });
});

describe("a paged view", () => {
  it("renders no editor for a member who could publish on the newest page", async () => {
    calls.versions = versions(5);

    const newest = await render();
    const older = await render({ before: "3" });

    expect(newest).toContain("<textarea");
    expect(older).not.toContain("<textarea");
    expect(older).not.toContain("<form");
    expect(older).not.toContain("expectedVersion");
  });

  it("marks nothing as current, because it does not know which is", async () => {
    calls.versions = versions(5);

    const html = await render({ before: "3" });

    expect(html).toContain("Version 2");
    expect(html).not.toContain(">Current<");
  });

  it("always offers the way back to the newest versions", async () => {
    calls.versions = versions(5);

    const html = await render({ before: "3" });

    expect(html).toContain(
      `href="/dashboard/${ORG}/systems/${SYSTEM}/disclosure"`,
    );
    expect(html).toContain("Back to the newest versions");
  });

  it("says so when there is nothing older, rather than nothing published", async () => {
    calls.versions = versions(2);

    const html = await render({ before: "1" });

    expect(html).toContain("There are no versions older than version 1.");
    expect(html).not.toContain("Nothing published yet");
    expect(html).toContain("Back to the newest versions");
  });

  it("shows a viewer the same page, with no editor on either", async () => {
    calls.role = "viewer";
    calls.versions = versions(5);

    expect(await render()).not.toContain("<textarea");
    expect(await render({ before: "3" })).not.toContain("<textarea");
  });
});

describe("a cursor the page cannot read", () => {
  it.each([
    ["a word", "nine"],
    ["zero", "0"],
    ["a negative number", "-1"],
    ["a decimal", "2.5"],
    ["above Postgres's integer", "2147483648"],
    ["an empty value", ""],
  ])("%s shows the newest versions and bounds nothing", async (_l, before) => {
    calls.versions = versions(3);

    const html = await render({ before });

    expect(calls.cursor).toBeUndefined();
    expect(html).toContain("Version 3");
    expect(html).toContain("<textarea");
    expect(html).not.toContain("Back to the newest versions");
  });

  it("the same parameter twice is ambiguous, so it is ignored", async () => {
    calls.versions = versions(3);

    const html = await render({ before: ["2", "1"] });

    expect(calls.cursor).toBeUndefined();
    expect(html).toContain("Version 3");
  });
});

describe("an archived system", () => {
  it("says nothing about the widget on an older page", async () => {
    calls.status = "archived";
    calls.versions = versions(5);

    const newest = await render();
    const older = await render({ before: "3" });

    expect(newest).toContain("This system is archived");
    expect(older).not.toContain("so the widget shows nothing for it");
  });
});
