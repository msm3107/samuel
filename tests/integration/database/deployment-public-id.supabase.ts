import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { SupabaseClient } from "@supabase/supabase-js";

import { isPublicDeploymentId } from "@/lib/security/public-id";
import {
  anonClient,
  createTenantFixtures,
  type TestOrganization,
} from "@/tests/security/tenant-isolation/support/tenants";

/**
 * `deployments.public_id` through the Data API (TASK-014): the database
 * issues it, the application's format check accepts every one it issues,
 * and no user chooses or changes it. The generator itself is tested in
 * supabase/tests/deployment-public-id.test.sql.
 */

const fixtures = createTenantFixtures();

let client: SupabaseClient;
let organization: TestOrganization;
let aiSystemId: string;

beforeAll(async () => {
  const owner = await fixtures.createUser();
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

function hostname(label: string) {
  return `${label}-${randomUUID().slice(0, 8)}.example.com`;
}

function register(host: string, extra: Record<string, unknown> = {}) {
  return client
    .from("deployments")
    .insert({
      organization_id: organization.id,
      ai_system_id: aiSystemId,
      hostname: host,
      ...extra,
    })
    .select("id, public_id")
    .single();
}

describe("a deployment's public ID", () => {
  it("is issued by the database, in the shape the application checks for", async () => {
    const ids = new Set<string>();
    for (let index = 0; index < 10; index += 1) {
      const { data, error } = await register(hostname("issued"));
      expect(error).toBeNull();
      expect(isPublicDeploymentId(data?.public_id)).toBe(true);
      ids.add(data?.public_id as string);
    }
    expect(ids.size).toBe(10);
  });

  it("cannot be chosen by a user", async () => {
    const { error } = await register(hostname("chosen"), {
      public_id: "dep_aaaaaaaaaaaaaaaaaaaaaaaaaa",
    });

    expect(error?.code).toBe("42501");
  });

  it("cannot be changed by a user", async () => {
    const { data: created } = await register(hostname("fixed"));

    const { error } = await client
      .from("deployments")
      .update({ public_id: "dep_bbbbbbbbbbbbbbbbbbbbbbbbbb" })
      .eq("id", created?.id as string);

    expect(error?.code).toBe("42501");
    const { data: after } = await client
      .from("deployments")
      .select("public_id")
      .eq("id", created?.id as string)
      .single();
    expect(after?.public_id).toBe(created?.public_id);
  });

  it("is new when an archived hostname is registered again", async () => {
    const host = hostname("again");
    const { data: first } = await register(host);
    await client
      .from("deployments")
      .update({ status: "archived" })
      .eq("id", first?.id as string);

    const { data: second, error } = await register(host);

    expect(error).toBeNull();
    expect(second?.public_id).not.toBe(first?.public_id);
  });

  it("can't be looked up anonymously: the lookup is TASK-019's endpoint", async () => {
    const { data: created } = await register(hostname("anonymous"));

    const { data, error } = await anonClient()
      .from("deployments")
      .select("id")
      .eq("public_id", created?.public_id as string);

    // No grant at all for the anonymous role: refused, not merely empty.
    expect(error?.code).toBe("42501");
    expect(data).toBeNull();
  });
});
