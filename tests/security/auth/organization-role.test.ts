import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

// The helper is a server-only module (it imports next/headers transitively
// through the session client).
vi.mock("server-only", () => ({}));

type MembershipRow = { organization_id: string; user_id: string; role: string };
type EqCall = { column: string; value: string };
type RecordedQuery = { table: string; eqCalls: EqCall[] };

const rows = vi.hoisted(() => [] as MembershipRow[]);
const recordedQueries = vi.hoisted(() => [] as RecordedQuery[]);
const dbErrorState = vi.hoisted(() => ({
  current: null as { message: string } | null,
}));
const sessionState = vi.hoisted(() => ({
  userId: null as string | null,
  error: null as unknown,
}));

const applyHeldRemovals = vi.hoisted(() => vi.fn());
const loggerInfo = vi.hoisted(() => vi.fn());
const loggerWarn = vi.hoisted(() => vi.fn());
const loggerError = vi.hoisted(() => vi.fn());
const loggerDebug = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/require-session", () => ({
  requireSession: async () => {
    if (sessionState.error !== null) {
      throw sessionState.error;
    }
    if (sessionState.userId === null) {
      throw new Error("test harness: session user was never configured");
    }
    return { userId: sessionState.userId };
  },
}));

vi.mock("@/lib/database/session-client", () => ({
  createResolvingSessionClient: async () => ({
    supabase: {
      from(table: string) {
        const eqCalls: EqCall[] = [];
        const builder = {
          select() {
            return builder;
          },
          eq(column: string, value: string) {
            eqCalls.push({ column, value });
            return builder;
          },
          async maybeSingle() {
            recordedQueries.push({ table, eqCalls: [...eqCalls] });
            if (dbErrorState.current !== null) {
              return { data: null, error: dbErrorState.current };
            }
            const organizationId = eqCalls.find(
              (call) => call.column === "organization_id",
            )?.value;
            const userId = eqCalls.find(
              (call) => call.column === "user_id",
            )?.value;
            const row = rows.find(
              (candidate) =>
                candidate.organization_id === organizationId &&
                candidate.user_id === userId,
            );
            return { data: row ? { role: row.role } : null, error: null };
          },
        };
        return builder;
      },
    },
    applyHeldRemovals,
  }),
}));

vi.mock("@/lib/logging/logger", () => ({
  logger: {
    info: loggerInfo,
    warn: loggerWarn,
    error: loggerError,
    debug: loggerDebug,
  },
}));

import {
  AuthenticationError,
  AuthorizationError,
  MembershipLookupError,
} from "@/lib/auth/errors";
import {
  ORGANIZATION_PERMISSIONS,
  type OrganizationPermission,
} from "@/lib/auth/organization-roles";
import {
  requireMemberManagement,
  requireOrganizationPermission,
  requireOrganizationRole,
} from "@/lib/auth/require-organization-role";

const ROLES = ["viewer", "member", "admin", "owner"] as const;

function setSession(userId: string) {
  sessionState.userId = userId;
  sessionState.error = null;
}

function setSessionError(error: unknown) {
  sessionState.error = error;
  sessionState.userId = null;
}

function addMembership(organizationId: string, userId: string, role: string) {
  rows.push({ organization_id: organizationId, user_id: userId, role });
}

function removeMembership(organizationId: string, userId: string) {
  const index = rows.findIndex(
    (row) => row.organization_id === organizationId && row.user_id === userId,
  );
  if (index !== -1) {
    rows.splice(index, 1);
  }
}

async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

afterEach(() => {
  rows.length = 0;
  recordedQueries.length = 0;
  dbErrorState.current = null;
  sessionState.userId = null;
  sessionState.error = null;
});

describe("requireOrganizationRole: a non-member is rejected", () => {
  it("rejects a user with no membership row at all", async () => {
    const userId = randomUUID();
    const organizationId = randomUUID();
    setSession(userId);

    const error = await captureRejection(
      requireOrganizationRole({ organizationId, minimumRole: "viewer" }),
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect((error as AuthorizationError).code).toBe(
      "organization_access_denied",
    );
  });
});

describe("requireOrganizationRole: a viewer is rejected for every write-level minimum", () => {
  it.each(["member", "admin", "owner"] as const)(
    "rejects a viewer against minimumRole %s",
    async (minimumRole) => {
      const userId = randomUUID();
      const organizationId = randomUUID();
      setSession(userId);
      addMembership(organizationId, userId, "viewer");

      const error = await captureRejection(
        requireOrganizationRole({ organizationId, minimumRole }),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
    },
  );

  const nonReadPermissions = (
    Object.keys(ORGANIZATION_PERMISSIONS) as OrganizationPermission[]
  ).filter((permission) => permission !== "organization.read");

  it.each(nonReadPermissions)(
    "rejects a viewer for permission %s via requireOrganizationPermission",
    async (permission) => {
      const userId = randomUUID();
      const organizationId = randomUUID();
      setSession(userId);
      addMembership(organizationId, userId, "viewer");

      const error = await captureRejection(
        requireOrganizationPermission({ organizationId, permission }),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
    },
  );

  it("lets a viewer through requireOrganizationPermission for organization.read", async () => {
    const userId = randomUUID();
    const organizationId = randomUUID();
    setSession(userId);
    addMembership(organizationId, userId, "viewer");

    await expect(
      requireOrganizationPermission({
        organizationId,
        permission: "organization.read",
      }),
    ).resolves.toMatchObject({ role: "viewer" });
  });
});

describe("requireOrganizationRole: each role passes at its own level and below", () => {
  const cases = ROLES.flatMap((role, roleIndex) =>
    ROLES.slice(0, roleIndex + 1).map(
      (minimumRole) => [role, minimumRole] as const,
    ),
  );

  it.each(cases)(
    "role %s passes at minimumRole %s and returns a frozen access object",
    async (role, minimumRole) => {
      const userId = randomUUID();
      const organizationId = randomUUID();
      setSession(userId);
      addMembership(organizationId, userId, role);

      const access = await requireOrganizationRole({
        organizationId,
        minimumRole,
      });

      expect(access).toEqual({ userId, organizationId, role });
      expect(Object.isFrozen(access)).toBe(true);
    },
  );
});

describe("requireOrganizationRole: indistinguishable denials", () => {
  it("gives the same class, code, message, keys, and no cause for a non-member, an under-privileged member, an invalid org id, and a different org", async () => {
    const userId = randomUUID();
    const organizationId = randomUUID();
    setSession(userId);

    const nonMember = await captureRejection(
      requireOrganizationRole({ organizationId, minimumRole: "viewer" }),
    );

    addMembership(organizationId, userId, "viewer");
    const underPrivileged = await captureRejection(
      requireOrganizationRole({ organizationId, minimumRole: "owner" }),
    );

    const invalidOrganizationId = await captureRejection(
      requireOrganizationRole({
        organizationId: "not-a-uuid",
        minimumRole: "viewer",
      }),
    );

    const differentOrganizationId = randomUUID();
    const differentOrg = await captureRejection(
      requireOrganizationRole({
        organizationId: differentOrganizationId,
        minimumRole: "viewer",
      }),
    );

    const errors = [
      nonMember,
      underPrivileged,
      invalidOrganizationId,
      differentOrg,
    ];

    for (const error of errors) {
      expect(error).toBeInstanceOf(AuthorizationError);
    }

    const [first, second, third, fourth] = errors as [
      AuthorizationError,
      AuthorizationError,
      AuthorizationError,
      AuthorizationError,
    ];
    for (const error of [second, third, fourth]) {
      expect(error.constructor).toBe(first.constructor);
      expect(error.message).toBe(first.message);
      expect(error.code).toBe(first.code);
      expect(Object.keys(error).sort()).toEqual(Object.keys(first).sort());
      expect(Object.prototype.hasOwnProperty.call(error, "cause")).toBe(false);
    }
    expect(Object.prototype.hasOwnProperty.call(first, "cause")).toBe(false);
  });
});

describe("requireOrganizationRole: identity cannot be smuggled through the argument object", () => {
  it("filters the membership lookup by the session's userId, not by any caller-supplied field", async () => {
    const sessionUserId = randomUUID();
    const organizationId = randomUUID();
    const realOwnerUserId = randomUUID();
    setSession(sessionUserId);
    addMembership(organizationId, realOwnerUserId, "owner");
    // sessionUserId itself has no membership row.

    const maliciousArgs = {
      organizationId,
      minimumRole: "owner",
      userId: realOwnerUserId,
      role: "owner",
    } as unknown as Parameters<typeof requireOrganizationRole>[0];

    const error = await captureRejection(
      requireOrganizationRole(maliciousArgs),
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    const query = recordedQueries.at(-1);
    expect(query?.table).toBe("memberships");
    expect(query?.eqCalls).toContainEqual({
      column: "user_id",
      value: sessionUserId,
    });
    expect(query?.eqCalls).not.toContainEqual({
      column: "user_id",
      value: realOwnerUserId,
    });
  });
});

describe("requireOrganizationRole: no caching of membership", () => {
  it("rejects a revoked membership on the very next call", async () => {
    const userId = randomUUID();
    const organizationId = randomUUID();
    setSession(userId);
    addMembership(organizationId, userId, "member");

    await expect(
      requireOrganizationRole({ organizationId, minimumRole: "member" }),
    ).resolves.toMatchObject({ role: "member" });

    removeMembership(organizationId, userId);

    const error = await captureRejection(
      requireOrganizationRole({ organizationId, minimumRole: "member" }),
    );
    expect(error).toBeInstanceOf(AuthorizationError);
  });
});

describe("requireOrganizationRole: database failures never look like a decision", () => {
  it("throws MembershipLookupError, not AuthorizationError, when the read errors", async () => {
    const userId = randomUUID();
    const organizationId = randomUUID();
    setSession(userId);
    dbErrorState.current = { message: "connection reset by peer" };

    const error = await captureRejection(
      requireOrganizationRole({ organizationId, minimumRole: "viewer" }),
    );

    expect(error).toBeInstanceOf(MembershipLookupError);
    expect(error).not.toBeInstanceOf(AuthorizationError);
  });

  it("throws MembershipLookupError for a row with an unknown role", async () => {
    const userId = randomUUID();
    const organizationId = randomUUID();
    setSession(userId);
    addMembership(organizationId, userId, "superadmin");

    const error = await captureRejection(
      requireOrganizationRole({ organizationId, minimumRole: "viewer" }),
    );

    expect(error).toBeInstanceOf(MembershipLookupError);
    expect(error).not.toBeInstanceOf(AuthorizationError);
  });
});

describe("requireOrganizationRole: never signs anyone out", () => {
  it("never applies held cookie removals, on success or on denial", async () => {
    const userId = randomUUID();
    const organizationId = randomUUID();
    setSession(userId);
    addMembership(organizationId, userId, "owner");

    // Success.
    await requireOrganizationRole({ organizationId, minimumRole: "owner" });

    // Denial: insufficient role.
    removeMembership(organizationId, userId);
    addMembership(organizationId, userId, "viewer");
    await captureRejection(
      requireOrganizationRole({ organizationId, minimumRole: "owner" }),
    );

    // Denial: not a member at all.
    removeMembership(organizationId, userId);
    await captureRejection(
      requireOrganizationRole({ organizationId, minimumRole: "owner" }),
    );

    expect(applyHeldRemovals).not.toHaveBeenCalled();
  });
});

describe("requireOrganizationRole: an invalid organization id never reaches the database", () => {
  it("never calls the database and never logs the raw invalid value", async () => {
    const userId = randomUUID();
    const rawInput = "'; DROP TABLE organizations; -- not-a-uuid";
    setSession(userId);

    const error = await captureRejection(
      requireOrganizationRole({
        organizationId: rawInput,
        minimumRole: "viewer",
      }),
    );

    expect(error).toBeInstanceOf(AuthorizationError);
    expect(recordedQueries).toEqual([]);
    for (const call of loggerInfo.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(rawInput);
    }
    for (const call of loggerWarn.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(rawInput);
    }
    for (const call of loggerError.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(rawInput);
    }
  });
});

describe("requireOrganizationRole: authentication failures propagate unchanged", () => {
  it("rethrows AuthenticationError from requireSession without querying the database", async () => {
    const authError = new AuthenticationError("session_missing");
    setSessionError(authError);

    const error = await captureRejection(
      requireOrganizationRole({
        organizationId: randomUUID(),
        minimumRole: "viewer",
      }),
    );

    expect(error).toBe(authError);
    expect(recordedQueries).toEqual([]);
  });
});

describe("requireMemberManagement", () => {
  it("rejects an admin acting on an owner", async () => {
    const organizationId = randomUUID();
    const adminId = randomUUID();
    const ownerId = randomUUID();
    setSession(adminId);
    addMembership(organizationId, adminId, "admin");
    addMembership(organizationId, ownerId, "owner");

    const error = await captureRejection(
      requireMemberManagement({ organizationId, targetUserId: ownerId }),
    );

    expect(error).toBeInstanceOf(AuthorizationError);
  });

  it("rejects an admin assigning the owner role to a member", async () => {
    const organizationId = randomUUID();
    const adminId = randomUUID();
    const memberId = randomUUID();
    setSession(adminId);
    addMembership(organizationId, adminId, "admin");
    addMembership(organizationId, memberId, "member");

    const error = await captureRejection(
      requireMemberManagement({
        organizationId,
        targetUserId: memberId,
        assignsRole: "owner",
      }),
    );

    expect(error).toBeInstanceOf(AuthorizationError);
  });

  it.each(["member", "viewer", "admin"] as const)(
    "lets an admin act on a %s target and returns the target read from the database",
    async (targetRole) => {
      const organizationId = randomUUID();
      const adminId = randomUUID();
      const targetId = randomUUID();
      setSession(adminId);
      addMembership(organizationId, adminId, "admin");
      addMembership(organizationId, targetId, targetRole);

      const access = await requireMemberManagement({
        organizationId,
        targetUserId: targetId,
      });

      expect(access.target).toEqual({ userId: targetId, role: targetRole });
    },
  );

  it("lets an owner act on another owner", async () => {
    const organizationId = randomUUID();
    const ownerId = randomUUID();
    const targetOwnerId = randomUUID();
    setSession(ownerId);
    addMembership(organizationId, ownerId, "owner");
    addMembership(organizationId, targetOwnerId, "owner");

    const access = await requireMemberManagement({
      organizationId,
      targetUserId: targetOwnerId,
    });

    expect(access.target).toEqual({ userId: targetOwnerId, role: "owner" });
  });

  it("lets an owner assign the owner role", async () => {
    const organizationId = randomUUID();
    const ownerId = randomUUID();
    const memberId = randomUUID();
    setSession(ownerId);
    addMembership(organizationId, ownerId, "owner");
    addMembership(organizationId, memberId, "member");

    const access = await requireMemberManagement({
      organizationId,
      targetUserId: memberId,
      assignsRole: "owner",
    });

    expect(access.target).toEqual({ userId: memberId, role: "member" });
  });

  it.each(["member", "viewer"] as const)(
    "rejects a %s acting as the manager",
    async (actorRole) => {
      const organizationId = randomUUID();
      const actorId = randomUUID();
      const targetId = randomUUID();
      setSession(actorId);
      addMembership(organizationId, actorId, actorRole);
      addMembership(organizationId, targetId, "member");

      const error = await captureRejection(
        requireMemberManagement({ organizationId, targetUserId: targetId }),
      );

      expect(error).toBeInstanceOf(AuthorizationError);
    },
  );

  it("rejects when the target is not a member", async () => {
    const organizationId = randomUUID();
    const adminId = randomUUID();
    setSession(adminId);
    addMembership(organizationId, adminId, "admin");

    const error = await captureRejection(
      requireMemberManagement({
        organizationId,
        targetUserId: randomUUID(),
      }),
    );

    expect(error).toBeInstanceOf(AuthorizationError);
  });

  it("rejects an invalid targetUserId", async () => {
    const organizationId = randomUUID();
    const adminId = randomUUID();
    setSession(adminId);
    addMembership(organizationId, adminId, "admin");

    const error = await captureRejection(
      requireMemberManagement({
        organizationId,
        targetUserId: "not-a-uuid",
      }),
    );

    expect(error).toBeInstanceOf(AuthorizationError);
  });

  it("gives the same AuthorizationError shape for every kind of rejection", async () => {
    const organizationId = randomUUID();
    const adminId = randomUUID();
    const ownerId = randomUUID();
    setSession(adminId);
    addMembership(organizationId, adminId, "admin");
    addMembership(organizationId, ownerId, "owner");

    const actingOnOwner = await captureRejection(
      requireMemberManagement({ organizationId, targetUserId: ownerId }),
    );
    const targetNotAMember = await captureRejection(
      requireMemberManagement({
        organizationId,
        targetUserId: randomUUID(),
      }),
    );
    const invalidTarget = await captureRejection(
      requireMemberManagement({
        organizationId,
        targetUserId: "not-a-uuid",
      }),
    );

    const [first, second, third] = [
      actingOnOwner,
      targetNotAMember,
      invalidTarget,
    ] as [AuthorizationError, AuthorizationError, AuthorizationError];
    for (const error of [second, third]) {
      expect(error.constructor).toBe(first.constructor);
      expect(error.message).toBe(first.message);
      expect(error.code).toBe(first.code);
    }
  });
});

describe.each(["billing.manage", "ownership.transfer"] as const)(
  "%s requires owner",
  (permission) => {
    it("passes for an owner", async () => {
      const organizationId = randomUUID();
      const userId = randomUUID();
      setSession(userId);
      addMembership(organizationId, userId, "owner");

      await expect(
        requireOrganizationPermission({ organizationId, permission }),
      ).resolves.toMatchObject({ role: "owner" });
    });

    it.each(["admin", "member", "viewer"] as const)(
      "rejects a %s",
      async (role) => {
        const organizationId = randomUUID();
        const userId = randomUUID();
        setSession(userId);
        addMembership(organizationId, userId, role);

        const error = await captureRejection(
          requireOrganizationPermission({ organizationId, permission }),
        );

        expect(error).toBeInstanceOf(AuthorizationError);
      },
    );
  },
);
