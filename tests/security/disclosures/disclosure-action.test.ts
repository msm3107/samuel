import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The disclosure editor's server action, with the session, the permission
 * check and the query layer faked (TASK-018). Proves, without Supabase, that
 * `publishDisclosureAction` authorizes before it reads the form: a refused
 * caller gets nothing back, not even what they typed, and the query is
 * never reached. The real-database suite
 * (tests/security/disclosures/disclosure-screen.supabase.ts) proves the same
 * boundary end to end, through RLS.
 */
const calls = vi.hoisted(() => ({
  permissions: [] as { organizationId: string; permission: string }[],
  publishes: [] as { organizationId: string; aiSystemId: string }[],
  role: "member" as string,
  publishResult: { status: "ok" } as unknown,
}));

vi.mock("@/lib/auth/require-session", () => ({
  requireSession: async () => ({ userId: "user-1" }),
  requireDashboardSession: async () => ({ userId: "user-1" }),
}));

vi.mock("@/lib/auth/require-organization-role", async () => {
  const { AuthorizationError } = await import("@/lib/auth/errors");
  const { minimumRoleFor, roleSatisfies } =
    await import("@/lib/auth/organization-roles");
  return {
    requireOrganizationPermission: async ({
      organizationId,
      permission,
    }: {
      organizationId: string;
      permission: Parameters<typeof minimumRoleFor>[0];
    }) => {
      calls.permissions.push({ organizationId, permission });
      if (
        !roleSatisfies(
          calls.role as Parameters<typeof roleSatisfies>[0],
          minimumRoleFor(permission),
        )
      ) {
        throw new AuthorizationError();
      }
      return { userId: "user-1", organizationId, role: calls.role };
    },
  };
});

vi.mock("@/features/disclosures/disclosure-queries", () => ({
  publishDisclosure: async (
    access: { organizationId: string },
    aiSystemId: string,
  ) => {
    calls.publishes.push({
      organizationId: access.organizationId,
      aiSystemId,
    });
    const result = calls.publishResult;
    if (result instanceof Error) {
      throw result;
    }
    return result;
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { publishDisclosureAction } from "@/app/(dashboard)/dashboard/[organizationId]/systems/[systemId]/disclosure/actions";
import { AuthorizationError } from "@/lib/auth/errors";
import { EMPTY_DISCLOSURE_FORM_VALUES } from "@/features/disclosures/disclosure-fields";
import { runAction } from "@/tests/support/next-interrupts";

const ORG = "0f6b2a4c-8d1e-4f3a-9b5c-6e7d8a9b0c1d";
const OTHER_ORG = "8d0c7c1e-3f6a-4f3e-9d6b-2f1c5a7e9b10";
const SYSTEM = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    data.append(name, value);
  }
  return data;
}

function validForm(overrides: Record<string, string> = {}) {
  return form({
    message: "A brief notice about our AI system.",
    language: "en",
    enabled: "on",
    ...overrides,
  });
}

beforeEach(() => {
  calls.permissions = [];
  calls.publishes = [];
  calls.role = "member";
  calls.publishResult = { status: "ok" };
});

describe("authorization happens before the form is read", () => {
  it("a viewer submitting an invalid body gets not_permitted, with empty values, never invalid and never their typed text", async () => {
    calls.role = "viewer";
    const typed = "text that must never come back";

    const outcome = await runAction(() =>
      publishDisclosureAction(
        ORG,
        SYSTEM,
        null,
        // Invalid: no language, and this message is fine, but it must never
        // be echoed, because a viewer never reaches validation at all.
        form({ message: typed, language: "", enabled: "on" }),
      ),
    );

    expect(outcome).toEqual({
      kind: "returned",
      value: {
        result: "not_permitted",
        fields: [],
        values: EMPTY_DISCLOSURE_FORM_VALUES,
      },
    });
    // Confirms the refusal really is "not_permitted", not "invalid".
    if (outcome.kind === "returned") {
      const state = outcome.value as { result: string; values: unknown };
      expect(state.result).not.toBe("invalid");
      expect(JSON.stringify(state.values)).not.toContain(typed);
    }
    expect(calls.permissions).toEqual([
      { organizationId: ORG, permission: "disclosures.manage" },
    ]);
    expect(calls.publishes).toEqual([]);
  });

  it("asks for disclosures.manage, for the organization bound to the action, not one the form supplies", async () => {
    calls.role = "member";
    calls.publishResult = {
      status: "ok",
      disclosure: {
        id: "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
        version: 1,
        message: "A brief notice about our AI system.",
        language: "en",
        enabled: true,
        createdAt: "2026-09-23T00:00:00.000000+00:00",
        createdBy: "user-1",
      },
    };

    await publishDisclosureAction(
      ORG,
      SYSTEM,
      null,
      validForm({ organizationId: OTHER_ORG }),
    );

    expect(calls.permissions).toEqual([
      { organizationId: ORG, permission: "disclosures.manage" },
    ]);
    // The query is called with the authorized organization (ORG, via the
    // mocked access object), never the smuggled OTHER_ORG.
    expect(calls.publishes).toEqual([
      { organizationId: ORG, aiSystemId: SYSTEM },
    ]);
  });
});

describe("a forged system ID", () => {
  it("a non-UUID systemId is ai_system_not_found, and no publish is attempted", async () => {
    calls.role = "member";

    const outcome = await runAction(() =>
      publishDisclosureAction(ORG, "not-a-uuid", null, validForm()),
    );

    expect(outcome).toEqual({
      kind: "returned",
      value: expect.objectContaining({ result: "ai_system_not_found" }),
    });
    expect(calls.publishes).toEqual([]);
  });

  it("a SQL-injection-shaped systemId is ai_system_not_found, and no publish is attempted", async () => {
    calls.role = "member";

    const outcome = await runAction(() =>
      publishDisclosureAction(ORG, `${SYSTEM}' or 1=1`, null, validForm()),
    );

    expect(outcome).toEqual({
      kind: "returned",
      value: expect.objectContaining({ result: "ai_system_not_found" }),
    });
    expect(calls.publishes).toEqual([]);
  });
});

describe("a version field that isn't a version number", () => {
  it.each([
    ["non-numeric text", "abc"],
    ["negative", "-1"],
    ["fractional", "1.5"],
    ["over Postgres's integer range", "2147483648"],
  ])("%s gives stale, and no publish is attempted", async (_label, value) => {
    calls.role = "member";

    const outcome = await runAction(() =>
      publishDisclosureAction(
        ORG,
        SYSTEM,
        null,
        validForm({ expectedVersion: value }),
      ),
    );

    expect(outcome).toEqual({
      kind: "returned",
      value: expect.objectContaining({ result: "stale" }),
    });
    expect(calls.publishes).toEqual([]);
  });
});

describe("an AuthorizationError from the query layer", () => {
  it("becomes not_permitted, as a role lowered after the check", async () => {
    calls.role = "member";
    calls.publishResult = new AuthorizationError();

    const outcome = await runAction(() =>
      publishDisclosureAction(ORG, SYSTEM, null, validForm()),
    );

    expect(outcome).toEqual({
      kind: "returned",
      value: expect.objectContaining({ result: "not_permitted" }),
    });
    expect(calls.publishes).toEqual([
      { organizationId: ORG, aiSystemId: SYSTEM },
    ]);
  });

  it("any other error thrown by the query layer is not swallowed", async () => {
    calls.role = "member";
    calls.publishResult = new Error("boom");

    await expect(
      publishDisclosureAction(ORG, SYSTEM, null, validForm()),
    ).rejects.toThrow("boom");
  });
});
