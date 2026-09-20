import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * The platform: whether this is Vercel, and the client address Vercel's header
 * carries. Everything else — the limiter, the gate, the actions, the callback
 * and supabase-js — runs as written, against the stub auth server and
 * database.
 */
const platform = vi.hoisted(() => ({
  onVercel: false,
  clientIp: "203.0.113.7",
}));

const jar = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  cookies: async () => ({
    getAll: () => [...jar].map(([name, value]) => ({ name, value })),
    get: (name: string) => {
      const value = jar.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: (name: string, value: string, options?: { maxAge?: number }) => {
      if (value === "" || options?.maxAge === 0) {
        jar.delete(name);
      } else {
        jar.set(name, value);
      }
    },
  }),
  headers: async () =>
    new Headers({
      host: "evil.example",
      "x-vercel-forwarded-for": platform.clientIp,
      // Never trusted: a client can write it, and so can a proxy in front of
      // Vercel.
      "x-forwarded-for": "198.18.0.1",
    }),
}));

vi.mock("@/lib/env/server-env", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/env/server-env")>();
  return {
    ...original,
    serverEnv: () => ({
      ...original.serverEnv(),
      ...(platform.onVercel ? { VERCEL: "1" } : {}),
    }),
  };
});

import { GET as callback } from "@/app/(auth)/auth/callback/route";
import {
  requestMagicLinkAction,
  startGoogleSignInAction,
} from "@/lib/auth/sign-in/actions";
import {
  FLOW_TICKET_COOKIE,
  issueFlowTicket,
  readFlowTicket,
} from "@/lib/auth/sign-in/flow-ticket";
import { requestMagicLink } from "@/lib/auth/sign-in/request-magic-link";
import { startGoogleSignIn } from "@/lib/auth/sign-in/start-google-sign-in";
import { logger } from "@/lib/logging/logger";
import { LOCAL_NETWORK } from "@/lib/security/client-ip";
import {
  GLOBAL,
  RATE_LIMITS,
  rateLimitKey,
  type RateLimitName,
} from "@/lib/security/rate-limit";
import {
  TURNSTILE_RESPONSE_FIELD,
  TURNSTILE_VERIFY_URL,
} from "@/lib/security/turnstile";
import {
  installStubAuthServer,
  type RecordedRateLimitCall,
} from "@/tests/security/auth/support/stub-auth-server";

const EMAIL = "zq.limited-person@example.test";
const AUTH_CODE = "3f2b8c1d-9a4e-4b7f-8c2d-1e6a5b9f0c33";

/** Well under the magic-link response floor (1200 ms). */
const WITHOUT_FLOOR_MS = 600;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  jar.clear();
  platform.onVercel = false;
  platform.clientIp = "203.0.113.7";
});

function key(name: RateLimitName, value: string) {
  return rateLimitKey(RATE_LIMITS[name].scope, value);
}

/** The stub database refuses exactly these buckets and allows the rest. */
function refusing(...keys: string[]) {
  return (call: RecordedRateLimitCall) => !keys.includes(call.key);
}

function installServer(
  rateLimit: Parameters<typeof installStubAuthServer>[1] = {},
) {
  return installStubAuthServer(
    { mode: "normal", users: [], pkceCodes: {} },
    rateLimit,
  );
}

/** Answers Cloudflare's siteverify; everything else goes to the stub. */
function stubSiteverify(answer: () => Response | Promise<Response>) {
  const inner = globalThis.fetch;
  const calls: URLSearchParams[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url === TURNSTILE_VERIFY_URL) {
        calls.push(new URLSearchParams(await request.text()));
        return answer();
      }
      return inner(input, init);
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

/** What siteverify answered Cloudflare's test secret (observed 2026-09-19). */
const TEST_KEY_PASS = () =>
  json({
    success: true,
    hostname: "example.com",
    "error-codes": [],
    metadata: { result_with_testing_key: true },
  });

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [name, value] of Object.entries(fields)) {
    data.set(name, value);
  }
  return data;
}

async function timed<T>(work: () => Promise<T>) {
  const started = performance.now();
  const result = await work();
  return { result, elapsedMs: performance.now() - started };
}

function authRequests(requests: { path: string }[]) {
  return requests.filter((request) => request.path.startsWith("/auth/v1/"));
}

function spyOnLogger() {
  return (["trace", "debug", "info", "warn", "error", "fatal"] as const).map(
    (level) => vi.spyOn(logger, level),
  );
}

describe("security: magic-link requests over a limit never reach Supabase Auth", () => {
  it("asks a busy network for the challenge instead of refusing it, without the floor", async () => {
    // Offices and mobile carriers share one address (TASK-003g).
    const { requests, rateLimitCalls } = installServer({
      rateLimit: refusing(key("magicLinkNetwork", LOCAL_NETWORK)),
    });

    const { result, elapsedMs } = await timed(() =>
      requestMagicLinkAction(null, form({ email: EMAIL })),
    );

    expect(result).toEqual({ result: "captcha_required" });
    expect(authRequests(requests)).toEqual([]);
    expect(elapsedMs).toBeLessThan(WITHOUT_FLOOR_MS);
    // A busy network spends none of the global allowance.
    expect(rateLimitCalls.map((call) => call.key)).toEqual([
      key("magicLinkNetworkCap", LOCAL_NETWORK),
      key("magicLinkNetwork", LOCAL_NETWORK),
    ]);
  });

  it("lets a busy network through with a solved challenge", async () => {
    const { requests } = installServer({
      rateLimit: refusing(key("magicLinkNetwork", LOCAL_NETWORK)),
    });
    const siteverify = stubSiteverify(TEST_KEY_PASS);

    const { result } = await timed(() =>
      requestMagicLinkAction(
        null,
        form({
          email: EMAIL,
          [TURNSTILE_RESPONSE_FIELD]: "XXXX.DUMMY.TOKEN.XXXX",
        }),
      ),
    );

    expect(result).toEqual({ result: "link_sent" });
    expect(siteverify.map((call) => call.get("response"))).toEqual([
      "XXXX.DUMMY.TOKEN.XXXX",
    ]);
    expect(authRequests(requests)).toHaveLength(1);
  });

  it("refuses a network past its cap at once, even with a solved challenge", async () => {
    const { requests, rateLimitCalls } = installServer({
      rateLimit: refusing(key("magicLinkNetworkCap", LOCAL_NETWORK)),
    });
    const siteverify = stubSiteverify(TEST_KEY_PASS);

    const { result, elapsedMs } = await timed(() =>
      requestMagicLinkAction(
        null,
        form({
          email: EMAIL,
          [TURNSTILE_RESPONSE_FIELD]: "XXXX.DUMMY.TOKEN.XXXX",
        }),
      ),
    );

    expect(result).toEqual({ result: "rate_limited" });
    expect(authRequests(requests)).toEqual([]);
    expect(siteverify).toEqual([]);
    expect(elapsedMs).toBeLessThan(WITHOUT_FLOOR_MS);
    expect(rateLimitCalls.map((call) => call.key)).toEqual([
      key("magicLinkNetworkCap", LOCAL_NETWORK),
    ]);
  });

  it("answers a repeated address with the sent-link result, without calling Supabase Auth", async () => {
    const { requests } = installServer({
      rateLimit: refusing(key("magicLinkAddress", EMAIL)),
    });

    await expect(requestMagicLink(EMAIL)).resolves.toBe("link_sent");
    expect(authRequests(requests)).toEqual([]);
    // No PKCE flow was started, so a link already sent keeps its verifier.
    // The flow ticket is issued either way, so the only difference from a sent
    // link is the verifier cookie: accepted residual risk, see the TASK-003c
    // contract.
    expect([...jar.keys()]).toEqual([FLOW_TICKET_COOKIE]);
  });

  it("holds a repeated address to the same response floor as a sent link", async () => {
    installServer({ rateLimit: refusing(key("magicLinkAddress", EMAIL)) });
    const limited = await timed(() =>
      requestMagicLinkAction(null, form({ email: EMAIL })),
    );

    vi.unstubAllGlobals();
    installServer();
    const sent = await timed(() =>
      requestMagicLinkAction(null, form({ email: EMAIL })),
    );

    expect(limited.result).toEqual({ result: "link_sent" });
    expect(sent.result).toEqual(limited.result);
    for (const { elapsedMs } of [limited, sent]) {
      expect(elapsedMs).toBeGreaterThanOrEqual(1150);
    }
  });

  it("checks the per-address limit only after the network and global limits", async () => {
    const { rateLimitCalls } = installServer();

    await requestMagicLink(EMAIL);
    await requestMagicLinkAction(null, form({ email: EMAIL }));

    expect(rateLimitCalls.slice(1).map((call) => call.key)).toEqual([
      key("magicLinkNetworkCap", LOCAL_NETWORK),
      key("magicLinkNetwork", LOCAL_NETWORK),
      key("magicLinkGlobal", GLOBAL),
      key("magicLinkAddress", EMAIL),
    ]);
  });

  it("consumes nothing for a malformed address", async () => {
    const { rateLimitCalls, requests } = installServer();

    const { result, elapsedMs } = await timed(() =>
      requestMagicLinkAction(null, form({ email: "not-an-address" })),
    );

    expect(result).toEqual({ result: "invalid_email" });
    expect(rateLimitCalls).toEqual([]);
    expect(authRequests(requests)).toEqual([]);
    expect(elapsedMs).toBeLessThan(WITHOUT_FLOOR_MS);
  });
});

describe("security: the limiter fails closed", () => {
  it("refuses a magic link as unavailable when the limiter cannot answer", async () => {
    const { requests } = installServer({ rateLimit: "unavailable" });

    const { result, elapsedMs } = await timed(() =>
      requestMagicLinkAction(null, form({ email: EMAIL })),
    );

    expect(result).toEqual({ result: "unavailable" });
    expect(authRequests(requests)).toEqual([]);
    expect(elapsedMs).toBeLessThan(WITHOUT_FLOOR_MS);
  });

  it("refuses a magic link as unavailable when only the per-address check fails", async () => {
    const { requests } = installServer({
      rateLimit: (call) => {
        if (call.key === key("magicLinkAddress", EMAIL)) {
          throw new Error("database gone");
        }
        return true;
      },
    });

    await expect(requestMagicLink(EMAIL)).resolves.toBe("unavailable");
    expect(authRequests(requests)).toEqual([]);
  });

  it("refuses to start Google sign-in when the limiter cannot answer", async () => {
    const { requests } = installServer({ rateLimit: "unavailable" });

    await expect(startGoogleSignIn(LOCAL_NETWORK)).resolves.toEqual({
      status: "unavailable",
    });
    expect(authRequests(requests)).toEqual([]);
  });

  it("refuses the callback exchange when the limiter cannot answer", async () => {
    const { requests } = installServer({ rateLimit: "unavailable" });
    await issueFlowTicket();

    const response = await callback(
      new NextRequest(`http://localhost:3000/auth/callback?code=${AUTH_CODE}`),
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/sign-in?error=sign_in_unavailable",
    );
    expect(authRequests(requests)).toEqual([]);
  });
});

describe("security: Google sign-in and the callback are limited per network", () => {
  it("refuses to start Google sign-in over the limit", async () => {
    const { requests } = installServer({
      rateLimit: refusing(key("googleStartNetwork", LOCAL_NETWORK)),
    });

    await expect(startGoogleSignIn(LOCAL_NETWORK)).resolves.toEqual({
      status: "rate_limited",
    });
    expect(authRequests(requests)).toEqual([]);
    expect([...jar.keys()]).toEqual([]);
  });

  it("sends the Google action back to sign-in with rate_limited", async () => {
    installServer({
      rateLimit: refusing(key("googleStartNetwork", LOCAL_NETWORK)),
    });

    const redirect = await startGoogleSignInAction().then(
      () => {
        throw new Error("expected a redirect");
      },
      (error: unknown) => error,
    );

    expect(String((redirect as { digest?: unknown }).digest)).toContain(
      "http://localhost:3000/sign-in?error=rate_limited",
    );
  });

  it("refuses the callback past the service-wide ceiling without calling GoTrue", async () => {
    const { requests } = installServer({
      rateLimit: refusing(key("callbackGlobal", GLOBAL)),
    });
    await issueFlowTicket();

    const response = await callback(
      new NextRequest(`http://localhost:3000/auth/callback?code=${AUTH_CODE}`),
    );

    // Not the visitor's network, so not "rate_limited".
    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/sign-in?error=sign_in_unavailable",
    );
    expect(authRequests(requests)).toEqual([]);
  });

  it("refuses the callback exchange over the limit", async () => {
    const { requests } = installServer({
      rateLimit: refusing(key("callbackNetwork", LOCAL_NETWORK)),
    });
    await issueFlowTicket();

    const response = await callback(
      new NextRequest(`http://localhost:3000/auth/callback?code=${AUTH_CODE}`),
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/sign-in?error=rate_limited",
    );
    expect(authRequests(requests)).toEqual([]);
  });

  it("spends nothing and calls no GoTrue for callbacks without a flow ticket", async () => {
    // The review of #9-#11: without this, a flood of bare callback URLs could
    // spend the service-wide ceiling and refuse everyone else's sign-in.
    const { requests, rateLimitCalls } = installServer();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await callback(
        new NextRequest(
          `http://localhost:3000/auth/callback?code=${AUTH_CODE}`,
        ),
      );
      expect(response.headers.get("location")).toBe(
        "http://localhost:3000/sign-in?error=link_other_browser",
      );
    }

    expect(rateLimitCalls).toEqual([]);
    expect(authRequests(requests)).toEqual([]);
  });

  it("refuses a forged flow ticket the same way", async () => {
    const { requests, rateLimitCalls } = installServer();
    jar.set(
      FLOW_TICKET_COOKIE,
      `${Math.floor(Date.now() / 1000)}.${"a".repeat(32)}.${"b".repeat(64)}`,
    );

    const response = await callback(
      new NextRequest(`http://localhost:3000/auth/callback?code=${AUTH_CODE}`),
    );

    expect(response.headers.get("location")).toBe(
      "http://localhost:3000/sign-in?error=link_other_browser",
    );
    expect(rateLimitCalls).toEqual([]);
    expect(authRequests(requests)).toEqual([]);
  });

  it("lets one ticket buy one exchange, and refuses a replay of its value", async () => {
    await issueFlowTicket();
    const ticket = jar.get(FLOW_TICKET_COOKIE) ?? "";
    const nonce = readFlowTicket(ticket) ?? "";
    let ticketAllowed = true;
    const { requests, rateLimitCalls } = installServer({
      rateLimit: (call) => {
        if (call.key === key("callbackTicket", nonce)) {
          const allowed = ticketAllowed;
          ticketAllowed = false;
          return allowed;
        }
        return true;
      },
    });

    await callback(
      new NextRequest(`http://localhost:3000/auth/callback?code=${AUTH_CODE}`),
    );
    const goTrueCallsAfterFirst = authRequests(requests).length;

    // The cookie is gone after the first exchange; an attacker replays its
    // value.
    jar.set(FLOW_TICKET_COOKIE, ticket);
    const replay = await callback(
      new NextRequest(`http://localhost:3000/auth/callback?code=${AUTH_CODE}`),
    );

    expect(replay.headers.get("location")).toBe(
      "http://localhost:3000/sign-in?error=link_invalid",
    );
    expect(authRequests(requests)).toHaveLength(goTrueCallsAfterFirst);
    // The replay spent no service-wide allowance.
    expect(
      rateLimitCalls.filter(
        (call) => call.key === key("callbackGlobal", GLOBAL),
      ),
    ).toHaveLength(1);
  });

  it("logs the ceiling alert once per window, not once per callback", async () => {
    const alertKey = key("callbackCeilingAlert", GLOBAL);
    let alertAllowed = true;
    installServer({
      rateLimit: (call) => {
        if (call.key === alertKey) {
          const allowed = alertAllowed;
          alertAllowed = false;
          return allowed;
        }
        return call.key !== key("callbackGlobal", GLOBAL);
      },
    });
    const error = vi.spyOn(logger, "error");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await issueFlowTicket();
      await callback(
        new NextRequest(
          `http://localhost:3000/auth/callback?code=${AUTH_CODE}`,
        ),
      );
    }

    expect(
      error.mock.calls.filter(
        ([entry]) =>
          (entry as { event?: string }).event ===
          "callback_global_ceiling_reached",
      ),
    ).toHaveLength(1);
  });

  it("spends no callback allowance on a malformed code", async () => {
    const { rateLimitCalls } = installServer();
    await issueFlowTicket();

    await callback(
      new NextRequest("http://localhost:3000/auth/callback?code=junk"),
    );

    expect(rateLimitCalls).toEqual([]);
  });
});

describe("security: client networks", () => {
  it("puts two addresses in one IPv6 /64 in the same bucket on Vercel", async () => {
    platform.onVercel = true;
    const { rateLimitCalls } = installServer({ rateLimit: () => false });

    platform.clientIp = "2001:db8:1:2::1";
    await requestMagicLinkAction(null, form({ email: EMAIL }));
    platform.clientIp = "2001:db8:1:2:ffff:ffff:ffff:fffe";
    await requestMagicLinkAction(null, form({ email: EMAIL }));
    platform.clientIp = "2001:db8:1:3::1";
    await requestMagicLinkAction(null, form({ email: EMAIL }));

    const [first, second, third] = rateLimitCalls.map((call) => call.key);
    expect(first).toBe(key("magicLinkNetworkCap", "2001:db8:1:2::/64"));
    expect(second).toBe(first);
    expect(third).not.toBe(first);
  });

  it("ignores every client-supplied IP header off Vercel", async () => {
    const { rateLimitCalls } = installServer({ rateLimit: () => false });

    await requestMagicLinkAction(null, form({ email: EMAIL }));

    expect(rateLimitCalls[0]?.key).toBe(
      key("magicLinkNetworkCap", LOCAL_NETWORK),
    );
  });

  it("sends only digests to the database and logs no address or IP", async () => {
    platform.onVercel = true;
    const spies = spyOnLogger();
    const { rateLimitCalls } = installServer({
      rateLimit: refusing(key("magicLinkAddress", EMAIL)),
    });

    await requestMagicLinkAction(null, form({ email: EMAIL }));

    const sent = JSON.stringify(rateLimitCalls);
    const logged = JSON.stringify(spies.map((spy) => spy.mock.calls));
    for (const raw of [EMAIL, platform.clientIp]) {
      expect(sent).not.toContain(raw);
      expect(logged).not.toContain(raw);
    }
  });
});

describe("security: past the global threshold, a challenge rather than a refusal", () => {
  const overThreshold = refusing(key("magicLinkGlobal", GLOBAL));

  it("asks for a challenge, at once and without calling Supabase Auth", async () => {
    const { requests } = installServer({ rateLimit: overThreshold });
    const siteverify = stubSiteverify(TEST_KEY_PASS);

    const { result, elapsedMs } = await timed(() =>
      requestMagicLinkAction(null, form({ email: EMAIL })),
    );

    expect(result).toEqual({ result: "captcha_required" });
    expect(authRequests(requests)).toEqual([]);
    expect(siteverify).toEqual([]);
    expect(elapsedMs).toBeLessThan(WITHOUT_FLOOR_MS);
  });

  it("sends the link when Cloudflare accepts the challenge", async () => {
    const { requests } = installServer({ rateLimit: overThreshold });
    const siteverify = stubSiteverify(TEST_KEY_PASS);

    const { result } = await timed(() =>
      requestMagicLinkAction(
        null,
        form({
          email: EMAIL,
          [TURNSTILE_RESPONSE_FIELD]: "XXXX.DUMMY.TOKEN.XXXX",
        }),
      ),
    );

    expect(result).toEqual({ result: "link_sent" });
    expect(siteverify.map((call) => call.get("response"))).toEqual([
      "XXXX.DUMMY.TOKEN.XXXX",
    ]);
    expect(authRequests(requests)).toHaveLength(1);
  });

  it("refuses a challenge Cloudflare rejects, without calling Supabase Auth", async () => {
    const { requests } = installServer({ rateLimit: overThreshold });
    stubSiteverify(() =>
      json({ success: false, "error-codes": ["invalid-input-response"] }),
    );

    const { result, elapsedMs } = await timed(() =>
      requestMagicLinkAction(
        null,
        form({ email: EMAIL, [TURNSTILE_RESPONSE_FIELD]: "forged" }),
      ),
    );

    expect(result).toEqual({ result: "captcha_failed" });
    expect(authRequests(requests)).toEqual([]);
    expect(elapsedMs).toBeLessThan(WITHOUT_FLOOR_MS);
  });

  it("is unavailable, not open, when Cloudflare cannot answer", async () => {
    const { requests } = installServer({ rateLimit: overThreshold });
    stubSiteverify(() => Promise.reject(new TypeError("fetch failed")));

    const { result, elapsedMs } = await timed(() =>
      requestMagicLinkAction(
        null,
        form({
          email: EMAIL,
          [TURNSTILE_RESPONSE_FIELD]: "XXXX.DUMMY.TOKEN.XXXX",
        }),
      ),
    );

    expect(result).toEqual({ result: "unavailable" });
    expect(authRequests(requests)).toEqual([]);
    expect(elapsedMs).toBeLessThan(WITHOUT_FLOOR_MS);
  });

  it("ignores a token below the threshold, so Cloudflare is not asked", async () => {
    installServer();
    const siteverify = stubSiteverify(TEST_KEY_PASS);

    await requestMagicLinkAction(
      null,
      form({
        email: EMAIL,
        [TURNSTILE_RESPONSE_FIELD]: "XXXX.DUMMY.TOKEN.XXXX",
      }),
    );

    expect(siteverify).toEqual([]);
  });

  it("raises the alert-level log once per window, not once per request", async () => {
    const alertKey = key("magicLinkThresholdAlert", GLOBAL);
    let alertAllowed = true;
    installServer({
      rateLimit: (call) => {
        if (call.key === alertKey) {
          const allowed = alertAllowed;
          alertAllowed = false;
          return allowed;
        }
        return overThreshold(call);
      },
    });
    const error = vi.spyOn(logger, "error");

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await requestMagicLinkAction(null, form({ email: EMAIL }));
    }

    expect(
      error.mock.calls.filter(
        ([entry]) =>
          (entry as { event?: string }).event ===
          "magic_link_global_threshold_exceeded",
      ),
    ).toHaveLength(1);
  });
});
