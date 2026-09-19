import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { serverEnv } from "@/lib/env/server-env";
import {
  consumeRateLimit,
  RATE_LIMIT_TIMEOUT_MS,
  RATE_LIMITS,
  RateLimitUnavailableError,
  rateLimitKey,
} from "@/lib/security/rate-limit";

afterEach(() => {
  vi.unstubAllGlobals();
});

type Call = { url: string; body: Record<string, unknown>; headers: Headers };

function stubDatabase(answer: () => Response | Promise<Response>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      calls.push({
        url: request.url,
        body: (await request.json()) as Record<string, unknown>,
        headers: request.headers,
      });
      return answer();
    }),
  );
  return calls;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("rateLimitKey", () => {
  it("is a 64-character lowercase hex digest, the only form the table accepts", () => {
    expect(rateLimitKey("magic_link:address", "person@example.test")).toMatch(
      /^[0-9a-f]{64}$/,
    );
  });

  it("never contains the raw value", () => {
    for (const value of ["person@example.test", "203.0.113.7", "global"]) {
      const key = rateLimitKey("scope", value);
      expect(key).not.toContain(value);
      expect(key).not.toContain(Buffer.from(value).toString("hex"));
    }
  });

  it("depends on the secret, so digests cannot be matched by hashing guesses", () => {
    const value = "person@example.test";
    expect(rateLimitKey("scope", value, "a".repeat(32))).not.toBe(
      rateLimitKey("scope", value, "b".repeat(32)),
    );
  });

  it("separates scopes, so one value's buckets in different limits never collide", () => {
    expect(rateLimitKey("magic_link:network", "203.0.113.7")).not.toBe(
      rateLimitKey("callback:network", "203.0.113.7"),
    );
  });
});

describe("consumeRateLimit", () => {
  it("calls the database function with the digest and the limit's parameters", async () => {
    const calls = stubDatabase(() => json(true));

    await expect(
      consumeRateLimit("magicLinkAddress", "person@example.test"),
    ).resolves.toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      `${serverEnv().SUPABASE_URL}/rest/v1/rpc/consume_rate_limit`,
    );
    expect(calls[0]?.body).toEqual({
      p_key: rateLimitKey("magic_link:address", "person@example.test"),
      p_limit: 3,
      p_window_seconds: 600,
      p_min_interval_seconds: 60,
    });
    expect(JSON.stringify(calls[0]?.body)).not.toContain("person@example.test");
  });

  it("uses the service-role key, the only role granted the function", async () => {
    const calls = stubDatabase(() => json(true));

    await consumeRateLimit("magicLinkNetwork", "203.0.113.7");

    expect(calls[0]?.headers.get("apikey")).toBe(
      serverEnv().SUPABASE_SERVICE_ROLE_KEY,
    );
  });

  it("resolves false when the limit is reached", async () => {
    stubDatabase(() => json(false));

    await expect(
      consumeRateLimit("magicLinkNetwork", "203.0.113.7"),
    ).resolves.toBe(false);
  });

  it.each([
    ["a database error", () => json({ code: "42501", message: "denied" }, 403)],
    ["a server error", () => json({ message: "boom" }, 500)],
    ["an answer that is not a boolean", () => json({ allowed: true })],
    ["a null answer", () => json(null)],
    [
      "a network failure",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ])("fails closed on %s", async (_label, answer) => {
    stubDatabase(answer);

    await expect(
      consumeRateLimit("magicLinkNetwork", "203.0.113.7"),
    ).rejects.toBeInstanceOf(RateLimitUnavailableError);
  });

  it("abandons a database call that hangs, as unavailable", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal(
        "fetch",
        vi.fn(
          (_input: RequestInfo | URL, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener("abort", () =>
                reject(init.signal?.reason),
              );
            }),
        ),
      );

      const outcome = consumeRateLimit("magicLinkNetwork", "203.0.113.7").then(
        () => "resolved",
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(RATE_LIMIT_TIMEOUT_MS + 10);

      await expect(outcome).resolves.toBeInstanceOf(RateLimitUnavailableError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after 2 seconds", () => {
    expect(RATE_LIMIT_TIMEOUT_MS).toBe(2000);
  });

  it("keeps the documented limits", () => {
    // A change here changes what an attacker can send; it must be deliberate.
    expect(
      Object.fromEntries(
        Object.entries(RATE_LIMITS).map(([name, limit]) => [
          name,
          [limit.limit, limit.windowSeconds, limit.minIntervalSeconds],
        ]),
      ),
    ).toEqual({
      magicLinkNetwork: [5, 600, 0],
      magicLinkNetworkCap: [30, 600, 0],
      magicLinkAddress: [3, 600, 60],
      magicLinkGlobal: [200, 3600, 0],
      magicLinkThresholdAlert: [1, 300, 0],
      googleStartNetwork: [30, 600, 0],
      callbackNetwork: [60, 600, 0],
      callbackGlobal: [40, 300, 0],
      callbackCeilingAlert: [1, 300, 0],
      sessionRefreshNetwork: [30, 300, 0],
    });
  });
});
