import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  createTenantFixtures,
  type TestOrganization,
  type TestUser,
} from "@/tests/security/tenant-isolation/support/tenants";

/**
 * The life of a deployment through the Data API as a signed-in member
 * (TASK-011): register, archive, register the hostname again, and the
 * owner's rules on uniqueness and archived AI systems. What the database
 * guarantees before TASK-013's services exist.
 */

const fixtures = createTenantFixtures();

let owner: TestUser;
let client: SupabaseClient;
let organization: TestOrganization;

beforeAll(async () => {
  owner = await fixtures.createUser();
  client = await fixtures.signedInClient(owner);
  organization = await fixtures.createOrganization({ ownerId: owner.id });
}, 30_000);

afterAll(async () => {
  await fixtures.cleanup();
});

async function createSystem(): Promise<string> {
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
  return data.id as string;
}

function hostname(label: string) {
  return `${label}-${randomUUID().slice(0, 8)}.example.com`;
}

function create(aiSystemId: string, host: string) {
  return client
    .from("deployments")
    .insert({
      organization_id: organization.id,
      ai_system_id: aiSystemId,
      hostname: host,
    })
    .select()
    .single();
}

function setStatus(id: string, status: "active" | "archived") {
  return client
    .from("deployments")
    .update({ status })
    .eq("id", id)
    .select()
    .single();
}

describe("a deployment's life", () => {
  it("is created active, with the database's id and timestamps", async () => {
    const system = await createSystem();
    const host = hostname("support");

    const { data, error } = await create(system, host);

    expect(error).toBeNull();
    expect(data).toMatchObject({
      organization_id: organization.id,
      ai_system_id: system,
      hostname: host,
      status: "active",
    });
    expect(data?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(data?.created_at).toBe(data?.updated_at);
  });

  it("refuses a hostname that isn't normalized, deterministically", async () => {
    const system = await createSystem();

    for (const host of [
      "Support.Example.com",
      "example.com.",
      "localhost",
      "127.0.0.1",
      // PR #25 review, finding 1: read as 127.0.0.1 and 169.254.169.254.
      "127.0.0.0x1",
      "169.254.169.0xfe",
      "https://example.com",
      "example.com:443",
    ]) {
      const { error } = await create(system, host);
      expect(error?.code, host).toBe("23514");
    }
  });

  it("is archived and restored, and updated_at moves", async () => {
    const system = await createSystem();
    const { data: created } = await create(system, hostname("cycle"));

    const archived = await setStatus(created?.id as string, "archived");
    const restored = await setStatus(created?.id as string, "active");

    expect(archived.error).toBeNull();
    expect(restored.error).toBeNull();
    expect(restored.data?.status).toBe("active");
    expect(
      new Date(restored.data?.updated_at as string).getTime(),
    ).toBeGreaterThan(new Date(created?.updated_at as string).getTime());
  });
});

describe("one active deployment per system and hostname (owner, 2026-09-22)", () => {
  it("refuses a second on the same system, allows it on another system, and allows it again once the first is archived", async () => {
    const first = await createSystem();
    const second = await createSystem();
    const host = hostname("shared");
    const { data: original } = await create(first, host);

    const clash = await create(first, host);
    expect(clash.error?.code).toBe("23505");

    const onAnotherSystem = await create(second, host);
    expect(onAnotherSystem.error).toBeNull();

    await setStatus(original?.id as string, "archived");
    const again = await create(first, host);
    expect(again.error).toBeNull();

    // Restoring the original would make two active deployments of one
    // system on one hostname.
    const restore = await setStatus(original?.id as string, "active");
    expect(restore.error?.code).toBe("23505");
  });

  it("resolves concurrent registrations deterministically: one row, the rest unique violations", async () => {
    const system = await createSystem();
    const host = hostname("race");

    const results = await Promise.all(
      Array.from({ length: 5 }, () => create(system, host)),
    );

    expect(results.filter(({ error }) => error === null)).toHaveLength(1);
    expect(
      results
        .filter(({ error }) => error !== null)
        .map(({ error }) => error?.code),
    ).toEqual(Array(4).fill("23505"));
  });
});

describe("archived AI systems (owner, 2026-09-22)", () => {
  it("refuses a new deployment and a restore under an archived system, and archiving the system leaves active deployments alone", async () => {
    const system = await createSystem();
    const { data: live } = await create(system, hostname("live"));
    const { data: old } = await create(system, hostname("old"));
    await setStatus(old?.id as string, "archived");

    await client
      .from("ai_systems")
      .update({ status: "archived" })
      .eq("id", system);

    const fresh = await create(system, hostname("fresh"));
    expect(fresh.error?.code).toBe("23514");
    expect(fresh.error?.message).toBe("a deployment's AI system is archived");

    const reactivate = await setStatus(old?.id as string, "active");
    expect(reactivate.error?.code).toBe("23514");

    const { data: stillLive } = await client
      .from("deployments")
      .select("status")
      .eq("id", live?.id as string)
      .single();
    expect(stillLive?.status).toBe("active");
  });

  it("allows both again once the system is restored", async () => {
    const system = await createSystem();
    const { data: old } = await create(system, hostname("back"));
    await setStatus(old?.id as string, "archived");
    await client
      .from("ai_systems")
      .update({ status: "archived" })
      .eq("id", system);
    await client
      .from("ai_systems")
      .update({ status: "active" })
      .eq("id", system);

    expect((await setStatus(old?.id as string, "active")).error).toBeNull();
    expect((await create(system, hostname("new"))).error).toBeNull();
  });
});

describe("every change is audited, however it was written", () => {
  it("a direct Data API registration, archive and restore each leave an event naming the user, with no hostname in it", async () => {
    const system = await createSystem();
    const host = hostname("audited");
    const { data: created } = await create(system, host);
    const id = created?.id as string;

    await setStatus(id, "archived");
    await setStatus(id, "active");

    const { data: events } = await fixtures.admin
      .from("audit_events")
      .select("actor_user_id, event_type, entity_type, metadata")
      .eq("entity_id", id)
      .order("created_at")
      .order("event_type");

    expect(events?.map(({ event_type }) => event_type)).toEqual([
      "deployment.created",
      "deployment.archived",
      "deployment.unarchived",
    ]);
    expect(
      events?.every(({ actor_user_id }) => actor_user_id === owner.id),
    ).toBe(true);
    expect(
      events?.every(({ entity_type }) => entity_type === "deployment"),
    ).toBe(true);
    expect(JSON.stringify(events)).not.toContain(host);
  });

  it("the service role, with no user to name, cannot register a deployment", async () => {
    const system = await createSystem();
    const host = hostname("service");

    const { error } = await fixtures.admin.from("deployments").insert({
      organization_id: organization.id,
      ai_system_id: system,
      hostname: host,
    });

    expect(error?.code).toBe("42501");
    const { count } = await fixtures.admin
      .from("deployments")
      .select("id", { count: "exact", head: true })
      .eq("hostname", host);
    expect(count).toBe(0);
  });

  it("the service role cannot delete a deployment: it is archived instead, and its history kept", async () => {
    const system = await createSystem();
    const { data: created } = await create(system, hostname("kept"));

    const { error } = await fixtures.admin
      .from("deployments")
      .delete()
      .eq("id", created?.id as string);

    expect(error?.code).toBe("42501");
    const { count } = await fixtures.admin
      .from("deployments")
      .select("id", { count: "exact", head: true })
      .eq("id", created?.id as string);
    expect(count).toBe(1);
  });

  it("a refused service-role archive leaves the row and the log as they were", async () => {
    const system = await createSystem();
    const { data: created } = await create(system, hostname("atomic"));

    const { error } = await fixtures.admin
      .from("deployments")
      .update({ status: "archived" })
      .eq("id", created?.id as string);

    expect(error?.code).toBe("42501");
    const { data } = await fixtures.admin
      .from("deployments")
      .select("status")
      .eq("id", created?.id as string)
      .single();
    expect(data?.status).toBe("active");
    const { count } = await fixtures.admin
      .from("audit_events")
      .select("id", { count: "exact", head: true })
      .eq("entity_id", created?.id as string)
      .eq("event_type", "deployment.archived");
    expect(count).toBe(0);
  });
});

/**
 * Archives an AI system in a second database session and holds the
 * transaction open for `holdMs` before committing. Resolves once the
 * archive has taken its row lock, with a promise for the commit.
 *
 * Runs `psql` inside the local Supabase database container, which both a
 * developer machine and CI's Supabase job have, so no Postgres client is
 * added to the project. The container is named after supabase/config.toml's
 * `project_id`.
 */
function archiveSystemAndHold(
  systemId: string,
  actorId: string,
  holdMs: number,
): Promise<{ committed: Promise<void> }> {
  const session = spawn(
    "docker",
    [
      "exec",
      "-i",
      "supabase_db_article50",
      "psql",
      "-U",
      "postgres",
      "-q",
      "-v",
      "ON_ERROR_STOP=1",
    ],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const claims = JSON.stringify({ sub: actorId, role: "authenticated" });
  session.stdin.end(
    [
      "begin;",
      // The AI system's audit trigger needs a signed-in actor.
      `select set_config('request.jwt.claims', '${claims}', true);`,
      `update public.ai_systems set status = 'archived' where id = '${systemId}';`,
      String.raw`\echo locked`,
      `select pg_sleep(${holdMs / 1000});`,
      "commit;",
    ].join("\n"),
  );

  let stderr = "";
  session.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const committed = new Promise<void>((resolve, reject) => {
    session.on("error", reject);
    session.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`psql exited with ${code}: ${stderr}`));
      }
    });
  });

  return new Promise((resolve, reject) => {
    session.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("locked")) {
        resolve({ committed });
      }
    });
    committed.catch(reject);
  });
}

describe("a registration racing an archive of its AI system", () => {
  it("waits for the archive to commit, then is refused: it never lands under the archived system", async () => {
    const system = await createSystem();
    const host = hostname("race-archive");

    const { committed } = await archiveSystemAndHold(system, owner.id, 1_500);
    // The archive holds the system's row lock, uncommitted. Without the
    // trigger's `for share`, this would read the still-active row and
    // succeed.
    const registration = await create(system, host);
    await committed;

    expect(registration.error?.code).toBe("23514");
    const { count } = await fixtures.admin
      .from("deployments")
      .select("id", { count: "exact", head: true })
      .eq("hostname", host);
    expect(count).toBe(0);
  });
});
