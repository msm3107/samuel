import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Which permission each dashboard page and action asks for, and that a
 * refusal stops it before any query (TASK-010). The real-database suite
 * (ai-systems-dashboard.supabase.ts) cannot see this layer on its own: when
 * an action asks for too little, the query functions' role check and RLS
 * still refuse the write. This suite is what guards the action's own check.
 */
const calls = vi.hoisted(() => ({
  permissions: [] as { organizationId: string; permission: string }[],
  queries: [] as string[],
  role: "viewer" as string,
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

vi.mock("@/features/ai-systems/ai-system-queries", () => {
  const record = (name: string) => async () => {
    calls.queries.push(name);
    throw new Error(`${name} must not be reached in this suite`);
  };
  return {
    AI_SYSTEM_LIST_LIMIT: 200,
    listAiSystems: record("listAiSystems"),
    readAiSystem: record("readAiSystem"),
    createAiSystem: record("createAiSystem"),
    updateAiSystem: record("updateAiSystem"),
  };
});

vi.mock("@/features/organizations/organization-queries", () => ({
  readOrganization: async () => {
    calls.queries.push("readOrganization");
    throw new Error("readOrganization must not be reached in this suite");
  },
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import {
  createAiSystemAction,
  setAiSystemStatusAction,
  updateAiSystemAction,
} from "@/app/(dashboard)/dashboard/[organizationId]/systems/actions";
import NewAiSystemPage from "@/app/(dashboard)/dashboard/[organizationId]/systems/new/page";
import AiSystemsPage from "@/app/(dashboard)/dashboard/[organizationId]/systems/page";
import AiSystemPage from "@/app/(dashboard)/dashboard/[organizationId]/systems/[systemId]/page";
import { renderPage, runAction } from "@/tests/support/next-interrupts";

const ORG = "8d0c7c1e-3f6a-4f3e-9d6b-2f1c5a7e9b10";
const SYSTEM = "9a8b7c6d-5e4f-4a3b-8c2d-000000000001";

function systemForm() {
  const data = new FormData();
  data.append("name", "Support bot");
  data.append("systemType", "chatbot");
  return data;
}

beforeEach(() => {
  calls.permissions = [];
  calls.queries = [];
});

describe("every write action asks for systems.manage, for the bound organization", () => {
  const actions = {
    create: () => createAiSystemAction(ORG, null, systemForm()),
    update: () => updateAiSystemAction(ORG, SYSTEM, null, systemForm()),
    archive: () =>
      setAiSystemStatusAction(ORG, SYSTEM, "archived", null, new FormData()),
  };

  for (const [name, action] of Object.entries(actions)) {
    it(`${name}: a viewer is refused before any query`, async () => {
      calls.role = "viewer";

      const outcome = await runAction(action);

      expect(outcome).toMatchObject({
        kind: "returned",
        value: { result: "not_permitted" },
      });
      expect(calls.permissions).toEqual([
        { organizationId: ORG, permission: "systems.manage" },
      ]);
      expect(calls.queries).toEqual([]);
    });
  }
});

describe("every page asks for the permission its screen needs", () => {
  it("the list and a system: organization.read", async () => {
    calls.role = "viewer";

    await expect(
      renderPage(() =>
        AiSystemsPage({
          params: Promise.resolve({ organizationId: ORG }),
          searchParams: Promise.resolve({}),
        }),
      ),
    ).rejects.toThrow("must not be reached");
    await expect(
      renderPage(() =>
        AiSystemPage({
          params: Promise.resolve({ organizationId: ORG, systemId: SYSTEM }),
        }),
      ),
    ).rejects.toThrow("must not be reached");

    expect(calls.permissions).toEqual([
      { organizationId: ORG, permission: "organization.read" },
      { organizationId: ORG, permission: "organization.read" },
    ]);
  });

  it("registration: systems.manage, and a viewer gets not-found before any query", async () => {
    calls.role = "viewer";

    const outcome = await renderPage(() =>
      NewAiSystemPage({ params: Promise.resolve({ organizationId: ORG }) }),
    );

    expect(outcome).toEqual({ kind: "not_found" });
    expect(calls.permissions).toEqual([
      { organizationId: ORG, permission: "systems.manage" },
    ]);
    expect(calls.queries).toEqual([]);
  });

  it("a non-UUID system is not found without a query", async () => {
    calls.role = "viewer";

    const outcome = await renderPage(() =>
      AiSystemPage({
        params: Promise.resolve({ organizationId: ORG, systemId: "nope" }),
      }),
    );

    expect(outcome).toEqual({ kind: "not_found" });
    expect(calls.queries).toEqual([]);
  });
});
