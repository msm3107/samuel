import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { createServiceRoleClient } from "@/lib/database/service-role-client";
import { serverEnv } from "@/lib/env/server-env";

/**
 * Shared fixtures for the tenant-isolation suites (and the schema/RLS
 * suites in tests/integration/database, which test the same tables): create
 * users and organizations through the service-role client, sign a user in
 * to get an `authenticated` client, and tear everything down afterwards.
 */

export interface TestUser {
  id: string;
  email: string;
  password: string;
}

export interface TestOrganization {
  id: string;
  name: string;
  slug: string;
  ownerMembershipId: string;
}

export interface TestMembership {
  id: string;
  organization_id: string;
  user_id: string;
  role: string;
}

/** A fresh, unused slug: `org-` plus eight hex characters. */
export function freshSlug(): string {
  return `org-${randomUUID().slice(0, 8)}`;
}

export function anonClient(): SupabaseClient {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = serverEnv();
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function createTenantFixtures() {
  const admin = createServiceRoleClient();
  const userIds: string[] = [];
  const organizationIds: string[] = [];

  async function createUser(): Promise<TestUser> {
    const email = `x-${randomUUID()}@example.test`;
    const password = `pw-${randomUUID()}`;
    const { data, error } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });
    if (error) {
      throw error;
    }
    userIds.push(data.user.id);
    return { id: data.user.id, email, password };
  }

  /** Signs a test user in on a fresh anon client: the `authenticated` role. */
  async function signedInClient(user: TestUser): Promise<SupabaseClient> {
    const client = anonClient();
    const signIn = await client.auth.signInWithPassword({
      email: user.email,
      password: user.password,
    });
    if (signIn.error) {
      throw signIn.error;
    }
    return client;
  }

  async function addMember(
    organizationId: string,
    userId: string,
    role: string,
  ): Promise<TestMembership> {
    const { data, error } = await admin
      .from("memberships")
      .insert({ organization_id: organizationId, user_id: userId, role })
      .select()
      .single();
    if (error) {
      throw error;
    }
    return data as TestMembership;
  }

  /** Inserts an organization and an owner membership for it, via service role. */
  async function createOrganization(options: {
    ownerId: string;
    name?: string;
  }): Promise<TestOrganization> {
    const slug = freshSlug();
    const name = options.name ?? `Org ${slug}`;
    const { data, error } = await admin
      .from("organizations")
      .insert({ name, slug })
      .select()
      .single();
    if (error) {
      throw error;
    }
    organizationIds.push(data.id as string);

    const ownerMembership = await addMember(
      data.id as string,
      options.ownerId,
      "owner",
    );

    return {
      id: data.id as string,
      name: data.name as string,
      slug: data.slug as string,
      ownerMembershipId: ownerMembership.id,
    };
  }

  /**
   * Deletes created organizations first — cascading their memberships, which
   * the last-owner trigger allows once the organization row itself is gone —
   * and only then deletes the users. Deleting a user who is still the last
   * owner of an existing organization is refused by the same trigger, so the
   * order here is load-bearing.
   */
  async function cleanup(): Promise<void> {
    // Organizations the fixtures inserted, plus any a test user created
    // through the application (TASK-007), which the fixtures never saw.
    const toDelete = new Set(organizationIds);
    if (userIds.length > 0) {
      const { data, error } = await admin
        .from("memberships")
        .select("organization_id")
        .in("user_id", userIds);
      if (error) {
        throw error;
      }
      for (const { organization_id } of data) {
        toDelete.add(organization_id as string);
      }
    }

    if (toDelete.size > 0) {
      const { error } = await admin
        .from("organizations")
        .delete()
        .in("id", [...toDelete]);
      if (error) {
        throw error;
      }
    }

    await Promise.all(userIds.map((id) => admin.auth.admin.deleteUser(id)));
  }

  return {
    admin,
    createUser,
    signedInClient,
    createOrganization,
    addMember,
    cleanup,
  };
}
