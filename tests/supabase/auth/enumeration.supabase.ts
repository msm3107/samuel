import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it, vi } from "vitest";

import { countMessagesTo } from "@/tests/supabase/support/mailpit";

/**
 * Whether the magic-link request reveals that an address has an account,
 * measured against real GoTrue — which the stub suites cannot tell apart.
 * Registered and unregistered addresses must get the same result code, and
 * their response times must not separate cleanly.
 *
 * Timed through the server action, which is what a visitor's request reaches.
 * GoTrue alone answers a registered address about three times faster than an
 * unregistered one; the action's response floor is what closes that gap.
 */

const jar = vi.hoisted(() => new Map<string, string>());

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
  }),
}));

import { requestMagicLinkAction } from "@/lib/auth/sign-in/actions";
import { createServiceRoleClient } from "@/lib/database/service-role-client";

const SAMPLES = 8;
const createdUserIds: string[] = [];

afterAll(async () => {
  const admin = createServiceRoleClient();
  await Promise.all(
    createdUserIds.map((id) => admin.auth.admin.deleteUser(id)),
  );
});

function address(kind: string) {
  return `enumeration-${kind}-${randomUUID()}@example.test`;
}

async function registeredAddress() {
  const email = address("registered");
  const { data, error } = await createServiceRoleClient().auth.admin.createUser(
    { email, email_confirm: true },
  );
  if (error) {
    throw error;
  }
  createdUserIds.push(data.user.id);
  return email;
}

async function timedRequest(email: string) {
  jar.clear();
  const form = new FormData();
  form.set("email", email);
  const started = performance.now();
  const state = await requestMagicLinkAction(null, form);
  return { email, result: state?.result, ms: performance.now() - started };
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

describe("magic-link requests against local Supabase", () => {
  it(
    "answers registered and unregistered addresses identically, and in comparable time",
    {
      // Sixteen requests, each held to the response floor.
      timeout: 90_000,
    },
    async () => {
      const registered = await Promise.all(
        Array.from({ length: SAMPLES }, registeredAddress),
      );
      const unregistered = Array.from({ length: SAMPLES }, () =>
        address("unregistered"),
      );

      // Interleaved, one at a time, so neither group gets a warmer server.
      const registeredRuns: Awaited<ReturnType<typeof timedRequest>>[] = [];
      const unregisteredRuns: Awaited<ReturnType<typeof timedRequest>>[] = [];
      for (let index = 0; index < SAMPLES; index += 1) {
        registeredRuns.push(await timedRequest(registered[index] ?? ""));
        unregisteredRuns.push(await timedRequest(unregistered[index] ?? ""));
      }

      // Same answer for every address.
      const results = new Set(
        [...registeredRuns, ...unregisteredRuns].map((run) => run.result),
      );
      expect([...results]).toEqual(["link_sent"]);

      // Every address, registered or not, actually received a link.
      for (const run of [...registeredRuns, ...unregisteredRuns]) {
        await expect.poll(() => countMessagesTo(run.email)).toBeGreaterThan(0);
      }

      // Timing: the medians must be close. A consistent gap an attacker could
      // measure over the network would show up here as a large ratio.
      const registeredMedian = median(registeredRuns.map((run) => run.ms));
      const unregisteredMedian = median(unregisteredRuns.map((run) => run.ms));
      const ratio =
        Math.max(registeredMedian, unregisteredMedian) /
        Math.min(registeredMedian, unregisteredMedian);

      expect(
        ratio,
        `median ms — registered ${registeredMedian.toFixed(1)}, unregistered ${unregisteredMedian.toFixed(1)}`,
      ).toBeLessThan(1.5);
    },
  );
});
