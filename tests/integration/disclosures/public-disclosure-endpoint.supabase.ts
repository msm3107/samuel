import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The public disclosure endpoint against the real local database
 * (TASK-019a): the whole path the widget will take — no session, the anon
 * key, `public.public_disclosure`, the real rate limiter — from a published
 * notice to what a visitor's browser receives.
 *
 * The mocked suite owns the refusals and the header matrix
 * (tests/security/disclosures/public-disclosure-route.test.ts); this one
 * owns the claim that the notice actually comes back, and that withdrawing
 * or archiving really does take it away.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { GET } from "@/app/api/public/disclosure/[publicId]/route";
import { PUBLIC_CACHE_CONTROL } from "@/lib/http/public-api";
import {
  createTenantFixtures,
  type TestOrganization,
  type TestUser,
} from "@/tests/security/tenant-isolation/support/tenants";

const fixtures = createTenantFixtures();

let owner: TestUser;
let member: SupabaseClient;
let organization: TestOrganization;

beforeAll(async () => {
  owner = await fixtures.createUser();
  member = await fixtures.signedInClient(owner);
  organization = await fixtures.createOrganization({ ownerId: owner.id });
}, 30_000);

afterAll(async () => {
  await fixtures.cleanup();
});

async function createSystem(): Promise<string> {
  const { data, error } = await member
    .from("ai_systems")
    .insert({
      organization_id: organization.id,
      name: `Public endpoint ${randomUUID().slice(0, 8)}`,
      system_type: "chatbot",
    })
    .select("id")
    .single();
  expect(error).toBeNull();
  return (data as { id: string }).id;
}

/** A deployment, and the public identifier the database issued it. */
async function createDeployment(
  aiSystemId: string,
): Promise<{ id: string; publicId: string }> {
  const { data, error } = await member
    .from("deployments")
    .insert({
      organization_id: organization.id,
      ai_system_id: aiSystemId,
      hostname: `d${randomUUID().slice(0, 8)}.example.com`,
    })
    .select("id, public_id")
    .single();
  expect(error).toBeNull();
  const row = data as { id: string; public_id: string };
  return { id: row.id, publicId: row.public_id };
}

async function publish(
  aiSystemId: string,
  message: string,
  options: { enabled?: boolean; expectedVersion?: number | null } = {},
): Promise<void> {
  const { error } = await member.rpc("publish_disclosure", {
    p_organization_id: organization.id,
    p_ai_system_id: aiSystemId,
    p_message: message,
    p_language: "en",
    p_enabled: options.enabled ?? true,
    p_expected_version: options.expectedVersion ?? null,
  });
  expect(error).toBeNull();
}

/** The request a widget makes: no session, no origin, nothing but the URL. */
function visit(publicId: string): Promise<Response> {
  return GET(
    new Request(`http://localhost:3000/api/public/disclosure/${publicId}`),
    { params: Promise.resolve({ publicId }) },
  );
}

describe("a visitor to a customer's site", () => {
  it("is served the current notice, with the public cache and CORS headers", async () => {
    const systemId = await createSystem();
    const { publicId } = await createDeployment(systemId);
    const message = `You are interacting with an AI system. ${randomUUID().slice(0, 8)}`;
    await publish(systemId, message);

    const response = await visit(publicId);
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(body).toEqual({ version: 1, language: "en", message });
    expect(response.headers.get("Cache-Control")).toBe(PUBLIC_CACHE_CONTROL);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    // A shared cache holds this response: nothing about a visitor may be in
    // it. The framework adds its own `Vary` downstream of the handler; the
    // end-to-end spec is where that is checked.
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(response.headers.get("Vary")).toBeNull();
  });

  it("is served the new version after a publish, not the old one", async () => {
    const systemId = await createSystem();
    const { publicId } = await createDeployment(systemId);
    await publish(systemId, `First. ${randomUUID().slice(0, 8)}`);
    const corrected = `Corrected. ${randomUUID().slice(0, 8)}`;
    await publish(systemId, corrected, { expectedVersion: 1 });

    const response = await visit(publicId);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      version: 2,
      language: "en",
      message: corrected,
    });
  });

  it("is told nothing when the notice is withdrawn", async () => {
    const systemId = await createSystem();
    const { publicId } = await createDeployment(systemId);
    await publish(systemId, `Shown for a while. ${randomUUID().slice(0, 8)}`);
    await publish(systemId, `No longer shown. ${randomUUID().slice(0, 8)}`, {
      enabled: false,
      expectedVersion: 1,
    });

    const response = await visit(publicId);

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "disclosure_not_found" },
    });
    // Withdrawal reaches visitors as fast as a publish does.
    expect(response.headers.get("Cache-Control")).toBe(PUBLIC_CACHE_CONTROL);
  });

  it("is told nothing when the deployment is archived, and served again when it is restored", async () => {
    const systemId = await createSystem();
    const deployment = await createDeployment(systemId);
    await publish(systemId, `Still published. ${randomUUID().slice(0, 8)}`);

    const archive = await member
      .from("deployments")
      .update({ status: "archived" })
      .eq("id", deployment.id);
    expect(archive.error).toBeNull();

    expect((await visit(deployment.publicId)).status).toBe(404);

    // `public_id` is fixed for a deployment's life (TASK-014), so the same
    // identifier resolves again rather than being dead forever.
    const restore = await member
      .from("deployments")
      .update({ status: "active" })
      .eq("id", deployment.id);
    expect(restore.error).toBeNull();

    expect((await visit(deployment.publicId)).status).toBe(200);
  });

  it("is told nothing for an identifier that names no deployment", async () => {
    const response = await visit("dep_aaaaaaaaaaaaaaaaaaaaaaaaaa");

    expect(response.status).toBe(404);
    // Indistinguishable from a withdrawn notice above: the endpoint is no
    // oracle for which deployments exist.
    expect(await response.json()).toEqual({
      error: { code: "disclosure_not_found" },
    });
  });

  it("is told plainly that a wrong-cased identifier is malformed", async () => {
    const systemId = await createSystem();
    const { publicId } = await createDeployment(systemId);
    await publish(systemId, `Published. ${randomUUID().slice(0, 8)}`);

    const response = await visit(publicId.toUpperCase());

    // PR #35 review, note 4: a mistyped identifier fails legibly at the
    // boundary rather than looking like a deployment with nothing to show.
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "invalid_deployment_id" },
    });
  });
});
