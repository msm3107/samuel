import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { SupabaseClient } from "@supabase/supabase-js";

import { runVerificationBatch } from "@/features/verification/run-verification";
import {
  readVerificationQueue,
  recordVerificationCheck,
  type VerificationCheckRecord,
} from "@/features/verification/verification-queries";
import { createServiceRoleClient } from "@/lib/database/service-role-client";
import {
  anonClient,
  createTenantFixtures,
  type TestOrganization,
  type TestUser,
} from "@/tests/security/tenant-isolation/support/tenants";

/**
 * The scheduler against the real database (TASK-025).
 *
 * The pgTAP suite owns the queue's where clause. This one owns what only a real
 * round trip can show: that the function is reachable through PostgREST with
 * the service-role key and not with the anon one, that the rows it returns
 * parse against the schema this application validates them with, that a row
 * written by the run is the row the table holds, and that a second run in the
 * same window writes nothing.
 *
 * Nothing here makes a network request to a customer's site: the fetch and the
 * inspection are injected, as they are in the unit tests. What is real is the
 * database.
 */

const fixtures = createTenantFixtures();

let owner: TestUser;
let member: SupabaseClient;
let organization: TestOrganization;
const admin = createServiceRoleClient();

/**
 * A fresh window per run, so one run's rows cannot collide with another's.
 *
 * In the past, necessarily: `check (check_window <= checked_at)` means a window
 * cannot begin after the check that belongs to it happened, and `checked_at` is
 * the database's own clock. A window in the future is refused by the table —
 * correctly, and it is the first thing this suite proved.
 */
const window = new Date(
  Date.UTC(2000, 0, 1) + Math.floor(Math.random() * 7000) * 86_400_000,
);

beforeAll(async () => {
  owner = await fixtures.createUser();
  member = await fixtures.signedInClient(owner);
  organization = await fixtures.createOrganization({ ownerId: owner.id });
}, 30_000);

afterAll(async () => {
  await fixtures.cleanup();
});

/** A system with a published, enabled notice, and one deployment for it. */
async function createCheckable(): Promise<{
  deploymentId: string;
  publicId: string;
  hostname: string;
}> {
  const system = await member
    .from("ai_systems")
    .insert({
      organization_id: organization.id,
      name: `Scheduler ${randomUUID().slice(0, 8)}`,
      system_type: "chatbot",
    })
    .select("id")
    .single();
  expect(system.error).toBeNull();
  const aiSystemId = (system.data as { id: string }).id;

  const disclosure = await member
    .from("disclosures")
    .insert({
      organization_id: organization.id,
      ai_system_id: aiSystemId,
      message: "You are interacting with an AI system.",
      language: "en",
    })
    .select("id")
    .single();
  expect(disclosure.error).toBeNull();

  const hostname = `s${randomUUID().slice(0, 8)}.example.com`;
  const deployment = await member
    .from("deployments")
    .insert({
      organization_id: organization.id,
      ai_system_id: aiSystemId,
      hostname,
    })
    .select("id, public_id")
    .single();
  expect(deployment.error).toBeNull();
  const { id, public_id: publicId } = deployment.data as {
    id: string;
    public_id: string;
  };

  return { deploymentId: id, publicId, hostname };
}

describe("reading the queue", () => {
  it("returns a deployment whose notice is published and enabled", async () => {
    const { deploymentId, publicId, hostname } = await createCheckable();

    const due = await readVerificationQueue(window, 100);
    const mine = due.filter((row) => row.deployment_id === deploymentId);

    // The rows parsed, which is the other half of this assertion: a column
    // added to the function's return type would fail the strict schema here
    // rather than reaching the run.
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({
      organization_id: organization.id,
      hostname,
      public_id: publicId,
    });
  });

  it("stops returning it once a check for the window exists", async () => {
    const { deploymentId, publicId } = await createCheckable();

    const before = await readVerificationQueue(window, 100);
    expect(before.some((row) => row.deployment_id === deploymentId)).toBe(true);

    const row = before.find((entry) => entry.deployment_id === deploymentId);
    expect(row).toBeDefined();
    const written = await recordVerificationCheck({
      organizationId: organization.id,
      deploymentId,
      disclosureId: row?.disclosure_id ?? "",
      checkWindow: window,
      status: "success",
      failureCode: null,
      httpStatus: 200,
      widgetDetected: true,
      metadata: { widget_tags: 1, charset: "utf-8" },
    });
    expect(written).toBe(true);
    expect(publicId).toMatch(/^dep_/);

    const after = await readVerificationQueue(window, 100);
    expect(after.some((entry) => entry.deployment_id === deploymentId)).toBe(
      false,
    );
  });

  it("refuses the same insert twice, and says so rather than throwing", async () => {
    // The idempotency TASK-022 chose: the second write of a window loses at the
    // constraint rather than in the route.
    const { deploymentId } = await createCheckable();
    const due = await readVerificationQueue(window, 100);
    const row = due.find((entry) => entry.deployment_id === deploymentId);
    expect(row).toBeDefined();

    const record: VerificationCheckRecord = {
      organizationId: organization.id,
      deploymentId,
      disclosureId: row?.disclosure_id ?? "",
      checkWindow: window,
      status: "failure",
      failureCode: "DNS_ERROR",
      httpStatus: null,
      widgetDetected: null,
      metadata: { scheme: "https", https_failed: true },
    };

    expect(await recordVerificationCheck(record)).toBe(true);
    expect(await recordVerificationCheck(record)).toBe(false);
  });

  it("is not readable with the anon key", async () => {
    // It crosses every tenant boundary by design, so no user-facing role may
    // call it. Asserted through PostgREST, where a missing execute grant is
    // what a real caller would meet.
    const { error } = await anonClient().rpc("verification_queue", {
      p_check_window: window.toISOString(),
      p_limit: 10,
    });

    expect(error).not.toBeNull();
  });
});

describe("a run against the real table", () => {
  it("writes the row it says it wrote", async () => {
    const { deploymentId, hostname } = await createCheckable();
    const due = await readVerificationQueue(window, 100);
    const mine = due.filter((row) => row.deployment_id === deploymentId);

    const summary = await runVerificationBatch(mine, window, {
      fetchPage: async () => ({
        ok: true as const,
        httpStatus: 200,
        finalUrl: `https://${hostname}/`,
        body: Buffer.from("<html></html>"),
        metadata: { scheme: "https" as const, https_failed: false },
      }),
      inspect: () => ({
        ok: true as const,
        widgetDetected: true as const,
        disclosureVersion: null,
        metadata: { widget_tags: 1, charset: "utf-8" },
      }),
      record: recordVerificationCheck,
    });

    expect(summary).toMatchObject({ considered: 1, succeeded: 1, errored: 0 });

    const { data, error } = await admin
      .from("verification_checks")
      .select(
        "status, failure_code, http_status, widget_detected, disclosure_version, metadata",
      )
      .eq("deployment_id", deploymentId)
      .eq("check_window", window.toISOString())
      .single();

    expect(error).toBeNull();
    expect(data).toMatchObject({
      status: "success",
      failure_code: null,
      http_status: 200,
      widget_detected: true,
      // TASK-024 cannot observe a version, so no row claims one.
      disclosure_version: null,
      metadata: { widget_tags: 1, charset: "utf-8" },
    });
  });

  it("writes a failure the table accepts, with what was observed", async () => {
    const { deploymentId } = await createCheckable();
    const due = await readVerificationQueue(window, 100);
    const mine = due.filter((row) => row.deployment_id === deploymentId);

    const summary = await runVerificationBatch(mine, window, {
      fetchPage: async () => ({
        ok: false as const,
        code: "CONNECTION_FAILED" as const,
        httpStatus: null,
        reason: null,
        metadata: { scheme: "https" as const, https_failed: true },
      }),
      inspect: () => {
        throw new Error("not reached");
      },
      record: recordVerificationCheck,
    });

    expect(summary).toMatchObject({ failed: 1, errored: 0 });

    const { data } = await admin
      .from("verification_checks")
      .select("status, failure_code, widget_detected, checked_at")
      .eq("deployment_id", deploymentId)
      .eq("check_window", window.toISOString())
      .single();

    expect(data).toMatchObject({
      status: "failure",
      failure_code: "CONNECTION_FAILED",
      widget_detected: null,
    });
    // The database's clock, not the run's: a job's clock is not evidence.
    const checkedAt = new Date(
      (data as { checked_at: string }).checked_at,
    ).getTime();
    expect(Math.abs(checkedAt - Date.now())).toBeLessThan(120_000);
  });

  it("writes nothing when our own code throws", async () => {
    // PR #40 review, note 4: a fault of ours is never recorded as a customer's
    // failed check, and the deployment stays in the queue.
    const { deploymentId } = await createCheckable();
    const due = await readVerificationQueue(window, 100);
    const mine = due.filter((row) => row.deployment_id === deploymentId);

    const summary = await runVerificationBatch(mine, window, {
      fetchPage: async () => {
        throw new TypeError("A hostname is required");
      },
      inspect: () => {
        throw new Error("not reached");
      },
      record: recordVerificationCheck,
    });

    expect(summary).toMatchObject({ errored: 1, failed: 0, succeeded: 0 });

    const { count } = await admin
      .from("verification_checks")
      .select("id", { count: "exact", head: true })
      .eq("deployment_id", deploymentId)
      .eq("check_window", window.toISOString());

    expect(count).toBe(0);

    const stillDue = await readVerificationQueue(window, 100);
    expect(stillDue.some((row) => row.deployment_id === deploymentId)).toBe(
      true,
    );
  });

  it("cannot be made to write a row a member could have written", async () => {
    // TASK-022 gave `authenticated` no insert grant, so evidence cannot be
    // manufactured by the customer it is about. Restated here because this is
    // the task that starts writing, and the run uses the service role.
    const { deploymentId } = await createCheckable();
    const due = await readVerificationQueue(window, 100);
    const row = due.find((entry) => entry.deployment_id === deploymentId);

    const { error } = await member.from("verification_checks").insert({
      organization_id: organization.id,
      deployment_id: deploymentId,
      disclosure_id: row?.disclosure_id ?? "",
      status: "success",
      check_window: window.toISOString(),
      http_status: 200,
      widget_detected: true,
    });

    expect(error).not.toBeNull();
  });
});
