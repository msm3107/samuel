import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * `POST /api/organizations` against the real local database (TASK-007).
 *
 * The session layer is routed to a real signed-in Supabase client (see
 * acting-user.ts), so every query the route makes runs under that user's JWT
 * and real RLS. The owner the database records is whoever the JWT names,
 * never a value the test passes.
 */
vi.mock(
  "@/lib/auth/require-session",
  async () =>
    (await import("@/tests/security/tenant-isolation/support/acting-user"))
      .requireSessionModule,
);
vi.mock(
  "@/lib/database/session-client",
  async () =>
    (await import("@/tests/security/tenant-isolation/support/acting-user"))
      .sessionClientModule,
);

import type { SupabaseClient } from "@supabase/supabase-js";

import { POST } from "@/app/api/organizations/route";
import { AUDIT_EVENTS } from "@/features/organizations/audit/audit-events";
import {
  actAs,
  runAs,
} from "@/tests/security/tenant-isolation/support/acting-user";
import {
  apiRequest,
  readError,
} from "@/tests/security/tenant-isolation/support/api-requests";
import {
  createTenantFixtures,
  type TestUser,
} from "@/tests/security/tenant-isolation/support/tenants";

const fixtures = createTenantFixtures();

function createRequest(name: string) {
  return apiRequest("POST", "/api/organizations", { body: { name } });
}

/** A name no other run or test uses, so its slug starts out free. */
function uniqueName(label: string) {
  return `${label} ${randomUUID().slice(0, 8)}`;
}

function slugOf(name: string) {
  return name.toLowerCase().replaceAll(" ", "-");
}

type CreatedBody = { organization: { id: string; name: string; slug: string } };

let creator: TestUser;
let creatorClient: SupabaseClient;

beforeAll(async () => {
  creator = await fixtures.createUser();
  creatorClient = await fixtures.signedInClient(creator);
}, 30_000);

afterAll(async () => {
  await fixtures.cleanup();
});

describe("creating an organization", () => {
  it("creates it, makes the caller its only member, as owner, and says only id, name and slug", async () => {
    actAs(creator, creatorClient);
    const name = uniqueName("Created Org");

    const response = await POST(createRequest(name));

    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = (await response.json()) as CreatedBody;
    expect(Object.keys(body)).toEqual(["organization"]);
    expect(Object.keys(body.organization).sort()).toEqual([
      "id",
      "name",
      "slug",
    ]);
    expect(body.organization.name).toBe(name);
    expect(body.organization.slug).toBe(slugOf(name));

    const { data: memberships } = await fixtures.admin
      .from("memberships")
      .select("user_id, role")
      .eq("organization_id", body.organization.id);
    expect(memberships).toEqual([{ user_id: creator.id, role: "owner" }]);
  });

  it("trims the name the way the form's user typed it", async () => {
    actAs(creator, creatorClient);
    const name = uniqueName("Trimmed Org");

    const response = await POST(createRequest(`  ${name}  `));

    expect(response.status).toBe(201);
    const body = (await response.json()) as CreatedBody;
    expect(body.organization.name).toBe(name);
  });

  it("writes organization.created and member.added in the same transaction, in the shapes the application's schemas accept", async () => {
    actAs(creator, creatorClient);

    const response = await POST(createRequest(uniqueName("Audited Org")));
    const { organization } = (await response.json()) as CreatedBody;

    const { data: membership } = await fixtures.admin
      .from("memberships")
      .select("id")
      .eq("organization_id", organization.id)
      .single();
    const { data: events } = await fixtures.admin
      .from("audit_events")
      .select("actor_user_id, event_type, entity_type, entity_id, metadata")
      .eq("organization_id", organization.id)
      .order("event_type");

    expect(events).toEqual([
      {
        actor_user_id: creator.id,
        event_type: "member.added",
        entity_type: "membership",
        entity_id: membership?.id,
        metadata: { role: "owner" },
      },
      {
        actor_user_id: creator.id,
        event_type: "organization.created",
        entity_type: "organization",
        entity_id: organization.id,
        metadata: {},
      },
    ]);

    // The database writes these rows itself, past the recorder's Zod check.
    // Its shapes must still be ones the recorder would have accepted.
    for (const event of events ?? []) {
      const definition =
        AUDIT_EVENTS[event.event_type as keyof typeof AUDIT_EVENTS];
      expect(definition.entityType).toBe(event.entity_type);
      expect(definition.metadata.safeParse(event.metadata).success).toBe(true);
    }
  });

  it("is never told a slug is taken: a second organization with the same name gets a suffixed slug", async () => {
    actAs(creator, creatorClient);
    const name = uniqueName("Twin Org");

    const first = (await (
      await POST(createRequest(name))
    ).json()) as CreatedBody;
    const second = await POST(createRequest(name));

    expect(second.status).toBe(201);
    const { organization } = (await second.json()) as CreatedBody;
    expect(first.organization.slug).toBe(slugOf(name));
    expect(organization.slug).toMatch(
      new RegExp(`^${slugOf(name)}-[0-9a-f]{6}$`),
    );
  });
});

describe("concurrent creation", () => {
  it("resolves the same slug deterministically: every request succeeds, one takes the plain slug, none shares one", async () => {
    const users = await Promise.all(
      Array.from({ length: 3 }, () => fixtures.createUser()),
    );
    const clients = await Promise.all(
      users.map((user) => fixtures.signedInClient(user)),
    );
    const name = uniqueName("Race Org");

    // Two requests from each of three users, all at once. Each keeps its
    // own user through every await; the race itself is in the database.
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_unused, index) => {
        const which = index % users.length;
        return runAs(
          users[which] as TestUser,
          clients[which] as SupabaseClient,
          () => POST(createRequest(name)),
        );
      }),
    );

    expect(responses.map((response) => response.status)).toEqual(
      Array(6).fill(201),
    );
    const created = await Promise.all(
      responses.map(
        async (response) =>
          ((await response.json()) as CreatedBody).organization,
      ),
    );
    const slugs = created.map(({ slug }) => slug);
    expect(new Set(slugs).size).toBe(6);
    expect(slugs.filter((slug) => slug === slugOf(name))).toHaveLength(1);

    // Each organization is owned by the user whose request created it.
    const { data: owners } = await fixtures.admin
      .from("memberships")
      .select("organization_id, user_id")
      .in(
        "organization_id",
        created.map(({ id }) => id),
      );
    const ownerOf = new Map(
      (owners ?? []).map((row) => [row.organization_id, row.user_id]),
    );
    created.forEach(({ id }, index) => {
      expect(ownerOf.get(id)).toBe(users[index % users.length]?.id);
    });
  });

  it("enforces the hourly cap under concurrency: twelve at once from one user create exactly ten", async () => {
    const user = await fixtures.createUser();
    const client = await fixtures.signedInClient(user);
    actAs(user, client);

    const responses = await Promise.all(
      Array.from({ length: 12 }, (_unused, index) =>
        POST(createRequest(uniqueName(`Capped Org ${index}`))),
      ),
    );

    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([...Array(10).fill(201), 429, 429]);
    const refused = responses.filter((response) => response.status === 429);
    for (const response of refused) {
      expect((await readError(response)).code).toBe(
        "organization_limit_reached",
      );
    }

    const { count } = await fixtures.admin
      .from("memberships")
      .select("id", { count: "exact", head: true })
      .eq("user_id", user.id);
    expect(count).toBe(10);
  });
});

describe("a failure after the organization insert", () => {
  it("leaves no organization behind, so none is ever ownerless", async () => {
    // A user whose JWT is still valid but whose account is gone: the
    // organization insert succeeds, the owner membership's foreign key to
    // auth.users then fails, and the whole call must roll back.
    const doomed = await fixtures.createUser();
    const doomedClient = await fixtures.signedInClient(doomed);
    const { error } = await fixtures.admin.auth.admin.deleteUser(doomed.id);
    expect(error).toBeNull();
    actAs(doomed, doomedClient);
    const name = uniqueName("Half Made Org");

    const response = await POST(createRequest(name));

    expect(response.status).toBe(500);
    expect((await readError(response)).code).toBe("internal_error");
    const { count } = await fixtures.admin
      .from("organizations")
      .select("id", { count: "exact", head: true })
      .eq("name", name);
    expect(count).toBe(0);
  });
});
