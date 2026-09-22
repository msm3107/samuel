import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  normalizeHostname,
  validateVerificationTarget,
} from "@/lib/security/verification-target";
import {
  createTenantFixtures,
  type TestOrganization,
  type TestUser,
} from "@/tests/security/tenant-isolation/support/tenants";

/**
 * TASK-012 against TASK-011's CHECK on `deployments.hostname`: every hostname
 * the validator approves is one the database stores unchanged, and every name
 * it calls malformed the database refuses too. The two copies of the shape
 * rule can't drift apart without this failing.
 */

const fixtures = createTenantFixtures();

let owner: TestUser;
let client: SupabaseClient;
let organization: TestOrganization;
let aiSystemId: string;

beforeAll(async () => {
  owner = await fixtures.createUser();
  client = await fixtures.signedInClient(owner);
  organization = await fixtures.createOrganization({ ownerId: owner.id });
  const { data, error } = await client
    .from("ai_systems")
    .insert({
      organization_id: organization.id,
      name: `System ${randomUUID().slice(0, 8)}`,
      system_type: "chatbot",
    })
    .select("id")
    .single();
  if (error) {
    throw error;
  }
  aiSystemId = data.id as string;
}, 30_000);

afterAll(async () => {
  await fixtures.cleanup();
});

function store(hostname: string) {
  return client
    .from("deployments")
    .insert({
      organization_id: organization.id,
      ai_system_id: aiSystemId,
      hostname,
    })
    .select("hostname")
    .single();
}

/** A fresh label, so no two cases collide on the unique index. */
function unique(prefix: string) {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

describe("what the validator approves, the database stores unchanged", () => {
  const label = "a".repeat(63);

  it.each([
    () => `${unique("shop")}.example.com`,
    () => `HTTPS://${unique("Shop")}.Example.com./`,
    () => `http://${unique("shop")}.example.com:80`,
    () => `${unique("bücher")}.de`,
    () => `${unique("shop")}.магазин.рф`,
    () => `${unique("shop")}.xn--p1ai`,
    () => `${unique("a")}.b-c.d1.co.uk`,
    // 253 characters, the longest name DNS allows.
    () => `${label}.${label}.${label}.${unique("b").padEnd(57, "b")}.com`,
  ])("case %#", async (makeInput) => {
    const result = validateVerificationTarget(makeInput());
    if (!result.ok) {
      throw new Error(`validator refused: ${result.code}`);
    }

    const { data, error } = await store(result.hostname);

    expect(error).toBeNull();
    expect(data?.hostname).toBe(result.hostname);
  });
});

describe("what the validator calls malformed, the database refuses too", () => {
  it.each([
    "intranet",
    "shop_1.example.com",
    "-shop.example.com",
    "shop-.example.com",
    "shop..example.com",
    "shop.example.123",
    "shop.example.0x1",
    // Not a number, so the URL parser keeps it as a name; only the rule that
    // the last label starts with a letter refuses it.
    "shop.example.1abc",
    `${"a".repeat(64)}.com`,
    `${"a".repeat(63)}.${"a".repeat(63)}.${"a".repeat(63)}.${"b".repeat(58)}.com`,
  ])("%j", async (name) => {
    expect(normalizeHostname(name)).toBeNull();
    expect(validateVerificationTarget(name)).toEqual({
      ok: false,
      code: "INVALID_TARGET",
    });

    const { error } = await store(name);

    expect(error?.code).toBe("23514");
  });
});
