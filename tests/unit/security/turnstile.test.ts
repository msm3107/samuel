import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const env = vi.hoisted(() => ({
  secret: "1x0000000000000000000000000000000AA",
}));

vi.mock("@/lib/env/server-env", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/lib/env/server-env")>();
  return {
    ...original,
    serverEnv: () => ({
      ...original.serverEnv(),
      NEXT_PUBLIC_APP_URL: "https://app.example.com",
      TURNSTILE_SECRET_KEY: env.secret,
    }),
  };
});

import {
  TURNSTILE_VERIFY_URL,
  TurnstileUnavailableError,
  verifyTurnstileToken,
} from "@/lib/security/turnstile";

const PRODUCTION_SECRET = "0x4AAAAAAAproductionSecretKey";
const TEST_SECRET = "1x0000000000000000000000000000000AA";

afterEach(() => {
  vi.unstubAllGlobals();
  env.secret = TEST_SECRET;
});

function stubSiteverify(answer: () => Response | Promise<Response>) {
  const requests: Request[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return answer();
    }),
  );
  return requests;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function passed(overrides: Record<string, unknown> = {}) {
  return json({
    success: true,
    hostname: "app.example.com",
    action: "magic_link",
    "error-codes": [],
    ...overrides,
  });
}

describe("verifyTurnstileToken", () => {
  it("accepts a token Cloudflare verifies for this hostname and action", async () => {
    env.secret = PRODUCTION_SECRET;
    const requests = stubSiteverify(() => passed());

    await expect(verifyTurnstileToken("token-value")).resolves.toBe(true);

    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.url).toBe(TURNSTILE_VERIFY_URL);
    expect(request?.method).toBe("POST");
    const form = new URLSearchParams(await request?.text());
    expect(form.get("secret")).toBe(PRODUCTION_SECRET);
    expect(form.get("response")).toBe("token-value");
    // The visitor's IP is not sent to Cloudflare.
    expect(form.has("remoteip")).toBe(false);
  });

  it.each([
    ["another hostname", { hostname: "evil.example" }],
    ["no hostname", { hostname: undefined }],
    ["another action", { action: "login" }],
    ["no action", { action: undefined }],
    [
      "a test-key answer, with a production secret",
      { metadata: { result_with_testing_key: true } },
    ],
  ])("refuses a verified token for %s", async (_label, overrides) => {
    env.secret = PRODUCTION_SECRET;
    stubSiteverify(() => passed(overrides));

    await expect(verifyTurnstileToken("token-value")).resolves.toBe(false);
  });

  // What siteverify actually answered the test secret on 2026-09-19.
  const TEST_KEY_ANSWER = {
    challenge_ts: "2026-09-19T05:03:51.871Z",
    "error-codes": [],
    hostname: "example.com",
    metadata: { result_with_testing_key: true },
    success: true,
  };

  it("accepts Cloudflare's test-key answer with a test secret", async () => {
    env.secret = TEST_SECRET;
    stubSiteverify(() => json(TEST_KEY_ANSWER));

    await expect(verifyTurnstileToken("XXXX.DUMMY.TOKEN.XXXX")).resolves.toBe(
      true,
    );
  });

  it("refuses an answer without the test-key flag when using a test secret", async () => {
    env.secret = TEST_SECRET;
    stubSiteverify(() => passed());

    await expect(verifyTurnstileToken("token-value")).resolves.toBe(false);
  });

  it.each(["invalid-input-response", "timeout-or-duplicate"])(
    "refuses a token Cloudflare rejects with %s",
    async (code) => {
      stubSiteverify(() => json({ success: false, "error-codes": [code] }));

      await expect(verifyTurnstileToken("token-value")).resolves.toBe(false);
    },
  );

  it.each([
    ["an empty token", ""],
    ["a token over 2048 characters", "x".repeat(2049)],
    ["a non-string", 42],
    ["a missing token", null],
  ])("refuses %s without asking Cloudflare", async (_label, token) => {
    const requests = stubSiteverify(() => passed());

    await expect(verifyTurnstileToken(token)).resolves.toBe(false);
    expect(requests).toHaveLength(0);
  });

  it.each([
    ["a network failure", () => Promise.reject(new TypeError("fetch failed"))],
    [
      "a timeout",
      () => Promise.reject(new DOMException("timed out", "TimeoutError")),
    ],
    ["a server error", () => json({}, 500)],
    ["an unreadable body", () => new Response("<html>", { status: 200 })],
    ["a malformed answer", () => json({ ok: true })],
    [
      "a rejected secret",
      () => json({ success: false, "error-codes": ["invalid-input-secret"] }),
    ],
    [
      "Cloudflare's internal error",
      () => json({ success: false, "error-codes": ["internal-error"] }),
    ],
  ])("fails closed on %s", async (_label, answer) => {
    stubSiteverify(answer);

    await expect(verifyTurnstileToken("token-value")).rejects.toBeInstanceOf(
      TurnstileUnavailableError,
    );
  });

  it("bounds the wait for Cloudflare at 5 seconds", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    let signal: AbortSignal | null | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal;
        return passed();
      }),
    );

    await verifyTurnstileToken("token-value");

    expect(timeout).toHaveBeenCalledWith(5000);
    expect(signal).toBe(timeout.mock.results[0]?.value);
  });
});
