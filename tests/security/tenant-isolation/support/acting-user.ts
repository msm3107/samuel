import { AsyncLocalStorage } from "node:async_hooks";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { TestUser } from "./tenants";

/**
 * Routes the session layer to a real, signed-in Supabase client, so a route
 * handler under test runs every query under that user's JWT and real RLS
 * (TASK-005's amendment, reused by TASK-007).
 *
 * Mock the two session modules with the factories below:
 *
 *   vi.mock("@/lib/auth/require-session", async () =>
 *     (await import("…/acting-user")).requireSessionModule);
 *   vi.mock("@/lib/database/session-client", async () =>
 *     (await import("…/acting-user")).sessionClientModule);
 *
 * `actAs` sets the user for what follows. `runAs` scopes one to a single
 * call and everything it awaits, so concurrent requests from different users
 * each keep their own identity.
 */
type Actor = Readonly<{ userId: string; supabase: SupabaseClient }>;

const scoped = new AsyncLocalStorage<Actor>();
let current: Actor | null = null;

export function actAs(user: TestUser, supabase: SupabaseClient): void {
  current = { userId: user.id, supabase };
}

export function runAs<T>(
  user: TestUser,
  supabase: SupabaseClient,
  call: () => T,
): T {
  return scoped.run({ userId: user.id, supabase }, call);
}

/** No actor at all, as for a request with no session. */
export function actAsNobody(): void {
  current = null;
}

function currentActor(): Actor | null {
  return scoped.getStore() ?? current;
}

/** Thrown where `requireSession` would throw for a missing session. */
async function authenticationError() {
  const { AuthenticationError } = await import("@/lib/auth/errors");
  return new AuthenticationError("session_missing");
}

export const requireSessionModule = {
  requireSession: async () => {
    const actor = currentActor();
    if (actor === null) {
      throw await authenticationError();
    }
    return Object.freeze({ userId: actor.userId });
  },
};

export const sessionClientModule = {
  createResolvingSessionClient: async () => {
    const actor = currentActor();
    if (actor === null) {
      throw new Error("test harness: no actor for the session client");
    }
    return { supabase: actor.supabase, applyHeldRemovals: () => {} };
  },
};
