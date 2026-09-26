import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * README §8's isolation check for `verification_checks` (TASK-022), against
 * the real local database, through the Data API as the `authenticated`
 * role — where the grants and the row-level security policy decide, rather
 * than the table owner's session that supabase/tests/ runs in.
 *
 * Nothing writes this table yet, so what is proven here is what a signed-in
 * user can do to evidence that already exists: read their own, read none of
 * anyone else's, and write nothing at all.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { VERIFICATION_FAILURE_CODES } from "@/features/verification/verification-check";
import {
  createTenantFixtures,
  type TestOrganization,
  type TestUser,
} from "@/tests/security/tenant-isolation/support/tenants";

const fixtures = createTenantFixtures();

let userA: TestUser;
let clientA: SupabaseClient;
let orgA: TestOrganization;
let orgB: TestOrganization;
/** One check in each organization, written as the service role. */
let checkA: string;
let checkB: string;

/**
 * The chain an evidence row needs. The AI system, the deployment and the
 * disclosure are created as a signed-in owner, because their triggers take
 * the author from the JWT, which the service role does not carry — and
 * because that is how they are created in production. Only the evidence row
 * is the service role's, which is also the production shape.
 */
async function seed(
  client: SupabaseClient,
  organizationId: string,
  hostname: string,
) {
  const { data: system, error: systemError } = await client
    .from("ai_systems")
    .insert({
      organization_id: organizationId,
      name: `Checked ${hostname}`,
      system_type: "chatbot",
    })
    .select("id")
    .single();
  if (systemError) {
    throw systemError;
  }
  const { data: deployment, error: deploymentError } = await client
    .from("deployments")
    .insert({
      organization_id: organizationId,
      ai_system_id: system.id,
      hostname,
    })
    .select("id")
    .single();
  if (deploymentError) {
    throw deploymentError;
  }
  const { data: disclosure, error: disclosureError } = await client.rpc(
    "publish_disclosure",
    {
      p_organization_id: organizationId,
      p_ai_system_id: system.id,
      p_message: "You are interacting with an AI system.",
      p_language: "en",
      p_enabled: true,
      p_expected_version: null,
    },
  );
  if (disclosureError) {
    throw disclosureError;
  }
  const { data: check, error: checkError } = await fixtures.admin
    .from("verification_checks")
    .insert({
      organization_id: organizationId,
      deployment_id: deployment.id,
      disclosure_id: (disclosure as { id: string }).id,
      status: "success",
      check_window: "2026-09-26T00:00:00Z",
      http_status: 200,
      widget_detected: true,
      disclosure_version: 1,
    })
    .select("id")
    .single();
  if (checkError) {
    throw checkError;
  }
  return check.id as string;
}

beforeAll(async () => {
  userA = await fixtures.createUser();
  clientA = await fixtures.signedInClient(userA);
  const ownerA = await fixtures.createUser();
  const ownerB = await fixtures.createUser();
  orgA = await fixtures.createOrganization({ ownerId: ownerA.id });
  orgB = await fixtures.createOrganization({ ownerId: ownerB.id });
  // A viewer: the least privileged role, because evidence is readable by
  // every member of a live organization.
  await fixtures.addMember(orgA.id, userA.id, "viewer");

  checkA = await seed(
    await fixtures.signedInClient(ownerA),
    orgA.id,
    `a-${orgA.slug}.example.com`,
  );
  checkB = await seed(
    await fixtures.signedInClient(ownerB),
    orgB.id,
    `b-${orgB.slug}.example.com`,
  );
}, 60_000);

afterAll(async () => {
  await fixtures.cleanup();
});

describe("verification checks, as a signed-in user", () => {
  it("reads its own organization's evidence, down to a viewer", async () => {
    // Both rows exist: without this, "A sees exactly one" would also pass
    // if B's row had never been written.
    const { data: all } = await fixtures.admin
      .from("verification_checks")
      .select("id")
      .in("id", [checkA, checkB]);
    expect((all as { id: string }[]).map((r) => r.id).sort()).toEqual(
      [checkA, checkB].sort(),
    );

    const { data, error } = await clientA
      .from("verification_checks")
      .select("id, organization_id, status");

    expect(error).toBeNull();
    expect(data).toEqual([
      { id: checkA, organization_id: orgA.id, status: "success" },
    ]);
  });

  it("reads none of another organization's, named directly", async () => {
    const { data, error } = await clientA
      .from("verification_checks")
      .select("id")
      .eq("id", checkB);

    // Refused as absence, not as an error: the same answer as for a row
    // that does not exist.
    expect(error).toBeNull();
    expect(data).toEqual([]);
  });

  it("cannot write evidence at all", async () => {
    const insert = await clientA.from("verification_checks").insert({
      organization_id: orgA.id,
      deployment_id: "00000000-0000-4000-8000-000000000001",
      disclosure_id: "00000000-0000-4000-8000-000000000002",
      status: "success",
      check_window: "2026-09-26T00:00:00Z",
    });
    // A member who could insert could manufacture their own compliance
    // history: there is no grant and no policy, so it fails on the grant.
    expect(insert.error).not.toBeNull();

    const update = await clientA
      .from("verification_checks")
      .update({ status: "failure" })
      .eq("id", checkA);
    expect(update.error).not.toBeNull();

    const remove = await clientA
      .from("verification_checks")
      .delete()
      .eq("id", checkA);
    expect(remove.error).not.toBeNull();

    // And the row is exactly as the service role left it.
    const { data } = await fixtures.admin
      .from("verification_checks")
      .select("status")
      .eq("id", checkA)
      .single();
    expect(data).toEqual({ status: "success" });
  });
});

describe("the failure codes", () => {
  it("are every one the database accepts, and nothing else", async () => {
    // The list is written out twice, here and in the migration's check
    // constraint. There is no direct SQL connection from these suites, only
    // PostgREST, so the constraint is exercised rather than read: every
    // code the application knows is written and has to land. A code added
    // to `VERIFICATION_FAILURE_CODES` and forgotten in a migration fails
    // here. The reverse direction — a code in the constraint that the
    // application does not know — is tests/unit/verification/.
    const { data: deployment } = await fixtures.admin
      .from("deployments")
      .select("id, ai_system_id")
      .eq("organization_id", orgA.id)
      .single();
    const { data: disclosure } = await fixtures.admin
      .from("disclosures")
      .select("id")
      .eq("organization_id", orgA.id)
      .single();

    const rows = VERIFICATION_FAILURE_CODES.map((code, index) => ({
      organization_id: orgA.id,
      deployment_id: (deployment as { id: string }).id,
      disclosure_id: (disclosure as { id: string }).id,
      status: "failure" as const,
      failure_code: code,
      // A distinct window each: one check per deployment per window. All
      // on a past day, because a window cannot begin after the check.
      check_window: `2026-09-25T${String(index).padStart(2, "0")}:00:00Z`,
    }));

    const { error } = await fixtures.admin
      .from("verification_checks")
      .insert(rows);

    expect(error).toBeNull();

    const { data: stored } = await fixtures.admin
      .from("verification_checks")
      .select("failure_code")
      .eq("organization_id", orgA.id)
      .not("failure_code", "is", null);
    expect(
      (stored as { failure_code: string }[])
        .map((row) => row.failure_code)
        .sort(),
    ).toEqual([...VERIFICATION_FAILURE_CODES].sort());
  });

  it("do not include SUCCESS, which status already says", async () => {
    const { data: deployment } = await fixtures.admin
      .from("deployments")
      .select("id")
      .eq("organization_id", orgA.id)
      .single();
    const { data: disclosure } = await fixtures.admin
      .from("disclosures")
      .select("id")
      .eq("organization_id", orgA.id)
      .single();

    const { error } = await fixtures.admin.from("verification_checks").insert({
      organization_id: orgA.id,
      deployment_id: (deployment as { id: string }).id,
      disclosure_id: (disclosure as { id: string }).id,
      status: "failure",
      failure_code: "SUCCESS",
      check_window: "2026-09-25T23:00:00Z",
    });

    // A second encoding of one fact is a second thing that can be wrong
    // (owner, 2026-09-26).
    expect(error).not.toBeNull();
    expect(VERIFICATION_FAILURE_CODES as readonly string[]).not.toContain(
      "SUCCESS",
    );
  });
});
