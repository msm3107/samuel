import { randomUUID } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * A fake `audit_events` table plus a controllable service-role factory,
 * driven from plain mutable state rather than `vi.fn(impl)` — this suite's
 * config runs with `restoreMocks: true`, which strips any implementation a
 * `vi.fn()` was given between tests, so per-test behaviour has to live in
 * closures over hoisted state instead (see tests/security/auth for the same
 * pattern with the session client).
 */
const db = vi.hoisted(() => ({
  inserted: [] as Array<{ table: string; row: unknown }>,
  insertError: null as { code: string; message: string } | null,
  insertThrows: null as unknown,
  createThrows: null as unknown,
}));

vi.mock("@/lib/database/service-role-client", () => ({
  createServiceRoleClient: () => {
    if (db.createThrows) {
      throw db.createThrows;
    }
    return {
      from: (table: string) => ({
        insert: async (row: unknown) => {
          if (db.insertThrows) {
            throw db.insertThrows;
          }
          db.inserted.push({ table, row });
          return { error: db.insertError };
        },
      }),
    };
  },
}));

const logger = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/lib/logging/logger", () => ({ logger }));

import type { OrganizationAccess } from "@/lib/auth/require-organization-role";

import type { AuditEvent } from "@/features/organizations/audit/audit-events";
import { recordAuditEvent } from "@/features/organizations/audit/record-audit-event";

function freshAccess(): OrganizationAccess {
  return Object.freeze({
    userId: randomUUID(),
    organizationId: randomUUID(),
    role: "owner",
  });
}

beforeEach(() => {
  db.inserted = [];
  db.insertError = null;
  db.insertThrows = null;
  db.createThrows = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("recordAuditEvent: success", () => {
  it("returns {recorded: true} and inserts exactly the expected row", async () => {
    const access = freshAccess();
    const event: AuditEvent = {
      type: "member.invited",
      entityId: randomUUID(),
      metadata: { role: "member" },
    };

    const result = await recordAuditEvent(access, event);

    expect(result).toEqual({ recorded: true });
    expect(db.inserted).toHaveLength(1);
    expect(db.inserted[0]?.table).toBe("audit_events");
    expect(db.inserted[0]?.row).toEqual({
      organization_id: access.organizationId,
      actor_user_id: access.userId,
      event_type: "member.invited",
      entity_type: "membership",
      entity_id: event.entityId,
      metadata: { role: "member" },
    });
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe("recordAuditEvent: invalid metadata never reaches the database", () => {
  it("returns {recorded: false}, inserts nothing, and logs once at error level", async () => {
    const access = freshAccess();
    const event = {
      type: "member.invited",
      entityId: randomUUID(),
      metadata: { role: "member", accessToken: "eyJhbGciOi.forged.token" },
    } as unknown as AuditEvent;

    const result = await recordAuditEvent(access, event);

    expect(result).toEqual({ recorded: false });
    expect(db.inserted).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledTimes(1);

    const [context, message] = logger.error.mock.calls[0] as [
      Record<string, unknown>,
      string,
    ];
    expect(message).toBe("An audit event could not be recorded");
    expect(context).toMatchObject({
      event: "audit_event_not_recorded",
      auditEventType: "member.invited",
      organizationId: access.organizationId,
    });
  });

  it("never lets the rejected metadata's keys or values reach the log", async () => {
    const access = freshAccess();
    const secret = "sk_live_SECRET_SHOULD_NOT_BE_LOGGED";
    const event = {
      type: "billing.plan_changed",
      entityId: randomUUID(),
      metadata: {
        fromPlan: "none",
        toPlan: "founder",
        stripeSignature: secret,
      },
    } as unknown as AuditEvent;

    await recordAuditEvent(access, event);

    for (const call of logger.error.mock.calls) {
      const serialized = JSON.stringify(call);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain("stripeSignature");
    }
  });

  it("logs an unknown event type as 'unknown' rather than echoing it", async () => {
    const access = freshAccess();
    const event = {
      type: "not.a.real.type",
      entityId: randomUUID(),
      metadata: {},
    } as unknown as AuditEvent;

    await recordAuditEvent(access, event);

    expect(logger.error).toHaveBeenCalledTimes(1);
    const [context] = logger.error.mock.calls[0] as [Record<string, unknown>];
    expect(context.auditEventType).toBe("unknown");
  });
});

describe("recordAuditEvent: database failure", () => {
  it("returns {recorded: false} and logs the error code when insert fails", async () => {
    const access = freshAccess();
    db.insertError = { code: "23505", message: "duplicate key" };
    const event: AuditEvent = {
      type: "organization.created",
      entityId: randomUUID(),
      metadata: {},
    };

    const result = await recordAuditEvent(access, event);

    expect(result).toEqual({ recorded: false });
    expect(logger.error).toHaveBeenCalledTimes(1);
    const [context] = logger.error.mock.calls[0] as [Record<string, unknown>];
    expect(context).toMatchObject({
      event: "audit_event_not_recorded",
      auditEventType: "organization.created",
      errorCode: "23505",
    });
  });

  it("returns {recorded: false} and never throws when insert itself throws", async () => {
    const access = freshAccess();
    db.insertThrows = new Error("connection reset");
    const event: AuditEvent = {
      type: "organization.created",
      entityId: randomUUID(),
      metadata: {},
    };

    await expect(recordAuditEvent(access, event)).resolves.toEqual({
      recorded: false,
    });
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("returns {recorded: false} and never rejects when createServiceRoleClient throws", async () => {
    const access = freshAccess();
    db.createThrows = new Error("service role key missing");
    const event: AuditEvent = {
      type: "organization.created",
      entityId: randomUUID(),
      metadata: {},
    };

    await expect(recordAuditEvent(access, event)).resolves.toEqual({
      recorded: false,
    });
    expect(db.inserted).toHaveLength(0);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
