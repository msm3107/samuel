import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  createDeploymentSchema,
  deploymentListFilterSchema,
  HOSTNAME_ERROR_CODES,
  updateDeploymentSchema,
} from "@/features/deployments/deployment";
import { serializeDeployment } from "@/features/deployments/deployment-queries";
import { VERIFICATION_TARGET_FAILURES } from "@/lib/security/verification-target";

/**
 * The deployment schemas (TASK-013), the hostname error code table against
 * TASK-012's own failure list, and the serializer that builds a client's
 * response from a database row.
 */

const AI_SYSTEM_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
const DEPLOYMENT_ID = "0f6b2a4c-8d1e-4f3a-9b5c-6e7d8a9b0c1d";
const ORGANIZATION_ID = "5b0e8d1a-2c4f-4e6a-9b8c-7d1e2f3a4b5c";

describe("createDeploymentSchema", () => {
  const valid = { aiSystemId: AI_SYSTEM_ID, hostname: "shop.example.com" };

  it("accepts a minimal valid input", () => {
    expect(createDeploymentSchema.parse(valid)).toEqual(valid);
  });

  it.each([
    ["organizationId", ORGANIZATION_ID],
    ["organization_id", ORGANIZATION_ID],
    ["id", DEPLOYMENT_ID],
    ["status", "active"],
    ["createdAt", "2000-01-01T00:00:00Z"],
    ["updatedAt", "2000-01-01T00:00:00Z"],
  ])("refuses a body that also carries %s", (field, value) => {
    expect(
      createDeploymentSchema.safeParse({ ...valid, [field]: value }).success,
    ).toBe(false);
  });

  it("refuses an unknown field", () => {
    expect(
      createDeploymentSchema.safeParse({ ...valid, extra: "nope" }).success,
    ).toBe(false);
  });

  it.each([
    ["a missing aiSystemId", { hostname: "shop.example.com" }],
    ["a missing hostname", { aiSystemId: AI_SYSTEM_ID }],
    [
      "an aiSystemId that is not a uuid",
      { ...valid, aiSystemId: "not-a-uuid" },
    ],
    ["an aiSystemId that is not a string", { ...valid, aiSystemId: 1234 }],
    [
      "a hostname over 1024 characters",
      { ...valid, hostname: "x".repeat(1025) },
    ],
    ["a non-string hostname", { ...valid, hostname: 12345 }],
  ])("refuses %s", (_label, body) => {
    expect(createDeploymentSchema.safeParse(body).success).toBe(false);
  });

  it("accepts a hostname exactly at the 1024-character limit", () => {
    expect(
      createDeploymentSchema.safeParse({ ...valid, hostname: "x".repeat(1024) })
        .success,
    ).toBe(true);
  });
});

describe("updateDeploymentSchema", () => {
  it.each(["active", "archived"])("accepts status %s", (status) => {
    expect(updateDeploymentSchema.safeParse({ status }).success).toBe(true);
  });

  it.each([
    ["an empty change", {}],
    ["an unknown status", { status: "deleted" }],
    [
      "a hostname alongside status",
      { status: "active", hostname: "x.example.com" },
    ],
    [
      "an aiSystemId alongside status",
      { status: "active", aiSystemId: AI_SYSTEM_ID },
    ],
    [
      "an organizationId alongside status",
      { status: "active", organizationId: ORGANIZATION_ID },
    ],
    ["an id alongside status", { status: "active", id: DEPLOYMENT_ID }],
  ])("refuses %s", (_label, change) => {
    expect(updateDeploymentSchema.safeParse(change).success).toBe(false);
  });
});

describe("deploymentListFilterSchema", () => {
  it("defaults to active", () => {
    expect(deploymentListFilterSchema.parse(undefined)).toBe("active");
  });

  it.each(["active", "archived", "all"])("accepts %s", (value) => {
    expect(deploymentListFilterSchema.parse(value)).toBe(value);
  });

  it.each(["deleted", "", "ALL"])("refuses %j", (value) => {
    expect(deploymentListFilterSchema.safeParse(value).success).toBe(false);
  });
});

describe("HOSTNAME_ERROR_CODES", () => {
  it("has exactly one entry, with its own distinct code, for every TASK-012 failure", () => {
    expect(Object.keys(HOSTNAME_ERROR_CODES).sort()).toEqual(
      [...VERIFICATION_TARGET_FAILURES].sort(),
    );
    const codes = Object.values(HOSTNAME_ERROR_CODES);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("serializeDeployment", () => {
  const ROW = {
    id: DEPLOYMENT_ID,
    public_id: "dep_abcdefghijklmnopqrstuvwxyz",
    ai_system_id: AI_SYSTEM_ID,
    hostname: "shop.example.com",
    status: "active",
    created_at: "2026-09-21T00:00:00Z",
    updated_at: "2026-09-21T10:00:00.123456+00:00",
    ai_system: { status: "active" },
  };

  it("builds only the documented fields, whatever else the row carries", () => {
    expect(
      serializeDeployment({
        ...ROW,
        organization_id: ORGANIZATION_ID,
        secret_internal_column: "should never surface",
      }),
    ).toEqual({
      id: DEPLOYMENT_ID,
      publicId: "dep_abcdefghijklmnopqrstuvwxyz",
      aiSystemId: AI_SYSTEM_ID,
      aiSystemStatus: "active",
      hostname: "shop.example.com",
      unicodeHostname: "shop.example.com",
      status: "active",
      createdAt: "2026-09-21T00:00:00Z",
      updatedAt: "2026-09-21T10:00:00.123456+00:00",
    });
  });

  it("a plain ASCII hostname's unicodeHostname equals the hostname", () => {
    const result = serializeDeployment(ROW);
    expect(result.unicodeHostname).toBe(result.hostname);
  });

  it("decodes an internationalized hostname to its Unicode reading", () => {
    const result = serializeDeployment({
      ...ROW,
      hostname: "xn--bcher-kva.de",
    });
    expect(result.hostname).toBe("xn--bcher-kva.de");
    expect(result.unicodeHostname).toBe(
      `b${String.fromCodePoint(0xfc)}cher.de`,
    );
  });

  it("decodes a lookalike hostname, which differs visibly from the ASCII form (PR #26 review, note 3)", () => {
    const result = serializeDeployment({
      ...ROW,
      hostname: "xn--pple-43d.com",
    });
    expect(result.unicodeHostname).toBe(
      `${String.fromCodePoint(0x430)}pple.com`,
    );
    expect(result.unicodeHostname).not.toBe(result.hostname);
  });

  it.each([
    ["a row missing every field", { id: "x" }],
    ["an ai_system_id that is not a uuid", { ...ROW, ai_system_id: "x" }],
    ["no public_id", { ...ROW, public_id: undefined }],
    [
      "a public_id with another prefix",
      { ...ROW, public_id: "sys_abcdefghijklmnopqrstuvwxyz" },
    ],
    [
      "a public_id with uppercase",
      { ...ROW, public_id: "dep_ABCDEFGHIJKLMNOPQRSTUVWXYZ" },
    ],
    ["a status the table doesn't allow", { ...ROW, status: "deleted" }],
    [
      "an ai_system with an unknown status",
      { ...ROW, ai_system: { status: "deleted" } },
    ],
    ["a missing ai_system embed", { ...ROW, ai_system: undefined }],
    [
      "a created_at that isn't a timestamp",
      { ...ROW, created_at: "yesterday" },
    ],
  ])("rejects %s", (_label, row) => {
    expect(() => serializeDeployment(row)).toThrow();
  });
});
