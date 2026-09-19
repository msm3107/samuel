import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { createServiceRoleClient } from "@/lib/database/service-role-client";
import { serverEnv } from "@/lib/env/server-env";
import { consumeRateLimit, rateLimitKey } from "@/lib/security/rate-limit";

/**
 * The rate-limit table and function (TASK-003c) against real local Postgres,
 * with the migration applied by `supabase start`.
 */

const createdUserIds: string[] = [];

afterAll(async () => {
  const admin = createServiceRoleClient();
  await Promise.all(
    createdUserIds.map((id) => admin.auth.admin.deleteUser(id)),
  );
});

/** A value no other test or run shares, so every bucket starts empty. */
function freshValue() {
  return `rate-limit-test-${randomUUID()}`;
}

function anonClient() {
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = serverEnv();
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** A client carrying a signed-in user's JWT: the `authenticated` role. */
async function authenticatedClient() {
  const email = `rate-limit-${randomUUID()}@example.test`;
  const password = `pw-${randomUUID()}`;
  const { data, error } = await createServiceRoleClient().auth.admin.createUser(
    {
      email,
      password,
      email_confirm: true,
    },
  );
  if (error) {
    throw error;
  }
  createdUserIds.push(data.user.id);

  const client = anonClient();
  const signIn = await client.auth.signInWithPassword({ email, password });
  if (signIn.error) {
    throw signIn.error;
  }
  return client;
}

const CALL = {
  p_limit: 5,
  p_window_seconds: 600,
  p_min_interval_seconds: 0,
};

describe("rate limits against local Postgres", () => {
  it("never allows more than the limit under concurrent requests", async () => {
    const value = freshValue();

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () =>
        consumeRateLimit("magicLinkNetwork", value),
      ),
    );

    expect(outcomes.filter(Boolean)).toHaveLength(5);
  });

  it("keeps a single address's requests at least 60 s apart", async () => {
    const value = freshValue();

    await expect(consumeRateLimit("magicLinkAddress", value)).resolves.toBe(
      true,
    );
    await expect(consumeRateLimit("magicLinkAddress", value)).resolves.toBe(
      false,
    );
  });

  it("starts a new window once the old one ends", async () => {
    const admin = createServiceRoleClient();
    const p_key = rateLimitKey("test:window", freshValue());
    const oneSecondLimitOfOne = {
      p_key,
      p_limit: 1,
      p_window_seconds: 1,
      p_min_interval_seconds: 0,
    };

    expect(
      (await admin.rpc("consume_rate_limit", oneSecondLimitOfOne)).data,
    ).toBe(true);
    expect(
      (await admin.rpc("consume_rate_limit", oneSecondLimitOfOne)).data,
    ).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(
      (await admin.rpc("consume_rate_limit", oneSecondLimitOfOne)).data,
    ).toBe(true);
  });

  it("refuses a key that is not a digest, so no raw value can be stored", async () => {
    const { error } = await createServiceRoleClient().rpc(
      "consume_rate_limit",
      { ...CALL, p_key: "person@example.test" },
    );

    expect(error).not.toBeNull();
  });

  it.each([
    ["anon", anonClient],
    ["authenticated", authenticatedClient],
  ])(
    "does not let the %s role call the function or read the table",
    async (_role, client) => {
      const supabase = await client();

      const call = await supabase.rpc("consume_rate_limit", {
        ...CALL,
        p_key: rateLimitKey("test:roles", freshValue()),
      });
      expect(call.error).not.toBeNull();
      expect(call.data).toBeNull();

      const read = await supabase
        .schema("private")
        .from("rate_limits")
        .select("*");
      expect(read.error).not.toBeNull();
      expect(read.data).toBeNull();

      const readPublic = await supabase.from("rate_limits").select("*");
      expect(readPublic.error).not.toBeNull();
    },
  );
});
