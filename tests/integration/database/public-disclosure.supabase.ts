import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  anonClient,
  createTenantFixtures,
  type TestOrganization,
  type TestUser,
} from "@/tests/security/tenant-isolation/support/tenants";

/**
 * `public.public_disclosure` as the widget's client will really reach it
 * (TASK-019): through PostgREST, with the anon key and no session. The
 * pgTAP suite owns the where clause; this one owns the grant — that an
 * unauthenticated caller can call this one function, gets only the three
 * fields, and still cannot read any of the four tables underneath it.
 */

const fixtures = createTenantFixtures();

let owner: TestUser;
let member: SupabaseClient;
let organization: TestOrganization;
/** No session at all: the widget's client. */
let visitor: SupabaseClient;

beforeAll(async () => {
  owner = await fixtures.createUser();
  member = await fixtures.signedInClient(owner);
  organization = await fixtures.createOrganization({ ownerId: owner.id });
  visitor = anonClient();
}, 30_000);

afterAll(async () => {
  await fixtures.cleanup();
});

async function createSystem(): Promise<string> {
  const { data, error } = await member
    .from("ai_systems")
    .insert({
      organization_id: organization.id,
      name: `Public lookup ${randomUUID().slice(0, 8)}`,
      system_type: "chatbot",
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return (data as { id: string }).id;
}

/** A deployment, and the public identifier the database issued it. */
async function createDeployment(aiSystemId: string): Promise<string> {
  const { data, error } = await member
    .from("deployments")
    .insert({
      organization_id: organization.id,
      ai_system_id: aiSystemId,
      hostname: `d${randomUUID().slice(0, 8)}.example.com`,
    })
    .select("public_id")
    .single();
  expect(error).toBeNull();
  return (data as { public_id: string }).public_id;
}

async function publish(
  aiSystemId: string,
  message: string,
  enabled = true,
): Promise<void> {
  const { error } = await member.rpc("publish_disclosure", {
    p_organization_id: organization.id,
    p_ai_system_id: aiSystemId,
    p_message: message,
    p_language: "en",
    p_enabled: enabled,
    p_expected_version: null,
  });
  expect(error).toBeNull();
}

async function lookup(publicId: string) {
  return visitor.rpc("public_disclosure", { p_public_id: publicId });
}

describe("a visitor with no session", () => {
  it("resolves a public identifier to the current notice, and nothing else", async () => {
    const systemId = await createSystem();
    const publicId = await createDeployment(systemId);
    const message = `You are interacting with an AI system. ${randomUUID().slice(0, 8)}`;
    await publish(systemId, message);

    const { data, error } = await lookup(publicId);

    expect(error).toBeNull();
    expect(data).toEqual([{ version: 1, language: "en", message }]);
    // No identifier, organization, system, hostname, time or author is in
    // the response: the keys are exactly the function's three columns.
    const rows = data as Record<string, unknown>[];
    expect(rows.map((row) => Object.keys(row).sort())).toEqual([
      ["language", "message", "version"],
    ]);
  });

  it("gets an empty answer for an identifier that names nothing", async () => {
    const { data, error } = await lookup("dep_aaaaaaaaaaaaaaaaaaaaaaaaaa");

    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("gets the same empty answer when the notice is turned off", async () => {
    const systemId = await createSystem();
    const publicId = await createDeployment(systemId);
    await publish(systemId, `Shown for a while. ${randomUUID().slice(0, 8)}`);
    const { error: offError } = await member.rpc("publish_disclosure", {
      p_organization_id: organization.id,
      p_ai_system_id: systemId,
      p_message: `No longer shown. ${randomUUID().slice(0, 8)}`,
      p_language: "en",
      p_enabled: false,
      p_expected_version: 1,
    });
    expect(offError).toBeNull();

    const { data, error } = await lookup(publicId);

    expect(error).toBeNull();
    // Indistinguishable from the unknown identifier above: the endpoint is
    // no oracle for which deployments exist.
    expect(data).toEqual([]);
  });

  it("still cannot read any of the four tables the lookup reads", async () => {
    for (const table of [
      "deployments",
      "ai_systems",
      "disclosures",
      "organizations",
    ]) {
      const { data, error } = await visitor.from(table).select("*").limit(1);

      // Either refused outright or empty; never a row. Both are acceptable
      // answers from PostgREST, and neither leaks anything.
      expect(error === null ? data : []).toEqual([]);
    }
  });

  it("cannot reach the rate limiter, which stays the service role's", async () => {
    const { error } = await visitor.rpc("consume_rate_limit", {
      p_key: "x".repeat(64),
      p_limit: 1,
      p_window_seconds: 60,
      p_min_interval_seconds: 0,
    });

    expect(error).not.toBeNull();
  });
});
