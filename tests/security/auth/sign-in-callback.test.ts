// Security: the PKCE callback route. Drives the real route handler, the real
// @supabase/ssr and supabase-js code, and the real sign-in functions against
// the stub auth server installed as `fetch`.
//
// What the stub does NOT model, and what these tests therefore cannot prove:
// the stub's `POST /auth/v1/token?grant_type=pkce` looks the auth code up in a
// table and ignores the `code_verifier` in the body entirely. Real GoTrue
// checks that S256(code_verifier) equals the code_challenge stored with the
// flow. So the browser-binding assertions below prove the *client* side of
// PKCE — that no exchange is attempted without a verifier this browser stored,
// and that the verifier sent is the one this browser stored — not that the
// auth server rejects a mismatched verifier.
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A cookie jar that behaves like a route handler's `next/headers` store:
 * writes are applied, so the PKCE verifier stored when a flow starts is there
 * when the callback reads it, and a session the callback writes is visible
 * afterwards.
 *
 * `headers()` answers with a spoofed Host, X-Forwarded-Host and Origin. No
 * code under test should read them; if any did and built a URL from it, the
 * Location assertions below would see `evil.example`.
 */
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
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "https",
      origin: "https://evil.example",
    }),
}));

import * as callbackRoute from "@/app/(auth)/auth/callback/route";
import { AuthenticationError } from "@/lib/auth/errors";
import { requireSession } from "@/lib/auth/require-session";
import { requestMagicLink } from "@/lib/auth/sign-in/request-magic-link";
import { CALLBACK_ERROR_CODES } from "@/lib/auth/sign-in/result-codes";
import { startGoogleSignIn } from "@/lib/auth/sign-in/start-google-sign-in";
import { logger } from "@/lib/logging/logger";

import {
  installStubAuthServer,
  sessionCookieName,
  USER_A,
  USER_B,
  type RecordedAuthRequest,
  type StubUser,
} from "./support/stub-auth-server";

const { GET } = callbackRoute;

const APP_URL = "http://localhost:3000";
const DASHBOARD_URL = `${APP_URL}/dashboard`;
const PKCE_PATH = "/auth/v1/token?grant_type=pkce";

/** Well-formed auth codes: 36-character UUIDs, the shape GoTrue issues. */
const CODE_VICTIM = "3f2b8c1d-9a4e-4b7f-8c2d-1e6a5b9f0c33";
const CODE_ATTACKER = "a1c4e7f0-2b5d-4e8a-9c1f-3d6b9e2a5c44";
const CODE_SECOND = "5e8b1d4a-7c0f-4a3d-8b6e-9f2c5a8d1b55";
const CODE_EXPIRED = "9c3d6a0f-1e4b-4d7c-a2f5-8b1e4c7a0d66";

/** Distinctive enough that a substring match in log output is meaningful. */
const SIGN_IN_EMAIL = "zq.callback-person@example.test";

afterEach(() => {
  vi.unstubAllGlobals();
  jar.clear();
});

// --- jar helpers -----------------------------------------------------------

function verifierCookieName() {
  return `${sessionCookieName()}-code-verifier`;
}

/** The session cookie and any chunks of it (`<name>.0`, `<name>.1`, …). */
function sessionCookieEntries() {
  const name = sessionCookieName();
  return [...jar].filter(
    ([cookieName]) =>
      cookieName === name || /^\d+$/.test(cookieName.slice(name.length + 1)),
  );
}

/** Reassembles and decodes the session `@supabase/ssr` stored in the jar. */
function storedSession(): unknown {
  const name = sessionCookieName();
  const encoded =
    jar.get(name) ??
    sessionCookieEntries()
      .sort(
        ([left], [right]) =>
          Number(left.slice(name.length + 1)) -
          Number(right.slice(name.length + 1)),
      )
      .map(([, value]) => value)
      .join("");
  if (!encoded) {
    return null;
  }
  return JSON.parse(decodeCookieValue(encoded));
}

function decodeCookieValue(value: string) {
  return value.startsWith("base64-")
    ? Buffer.from(value.slice("base64-".length), "base64url").toString("utf8")
    : value;
}

/** Every jar value, decoded, so a token cannot hide inside base64. */
function decodedJarText() {
  return [...jar]
    .map(([name, value]) => `${name}=${decodeCookieValue(value)}`)
    .join("\n");
}

/** The verifier auth-js stored for the most recently started flow. */
function storedVerifier(): string {
  const raw = jar.get(verifierCookieName());
  if (raw === undefined) {
    throw new Error(
      `no verifier cookie; jar holds: ${[...jar.keys()].join(", ")}`,
    );
  }
  const parsed: unknown = JSON.parse(decodeCookieValue(raw));
  if (typeof parsed !== "string") {
    throw new Error("expected the stored verifier to be a string");
  }
  return parsed;
}

// --- request/response helpers ---------------------------------------------

/** `query` is a raw query string so hostile spellings survive untouched. */
function callbackRequest(query = "", headers?: Record<string, string>) {
  const url = `${APP_URL}/auth/callback${query}`;
  return headers ? new NextRequest(url, { headers }) : new NextRequest(url);
}

function pkceRequests(requests: RecordedAuthRequest[]) {
  return requests.filter((request) => request.path === PKCE_PATH);
}

function locationOf(response: Response) {
  const location = response.headers.get("location");
  if (location === null) {
    throw new Error("expected a Location header on the redirect");
  }
  return location;
}

function expectRedirect(response: Response) {
  expect(response.status).toBe(303);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
}

/**
 * Asserts a failure redirect: 303, private/no-store, exactly
 * `<app>/sign-in?error=<allowlisted code>` and nothing else in the URL.
 */
function expectSignInError(response: Response, code: string) {
  expectRedirect(response);
  expect([...CALLBACK_ERROR_CODES]).toContain(code);

  const location = locationOf(response);
  expect(location).toBe(`${APP_URL}/sign-in?error=${code}`);

  const url = new URL(location);
  expect(url.origin).toBe(APP_URL);
  expect(url.pathname).toBe("/sign-in");
  expect(url.hash).toBe("");
  expect(Object.fromEntries(url.searchParams)).toEqual({ error: code });
}

function expectSignedInRedirect(response: Response) {
  expectRedirect(response);
  const location = locationOf(response);
  expect(location).toBe(DASHBOARD_URL);
  expect(new URL(location).search).toBe("");
}

function expectNoSession() {
  expect(sessionCookieEntries()).toEqual([]);
  const decoded = decodedJarText();
  for (const user of [USER_A, USER_B]) {
    expect(decoded).not.toContain(user.accessToken);
    expect(decoded).not.toContain(user.refreshToken);
  }
}

// --- flow helpers ----------------------------------------------------------

function installFlowServer(
  pkceCodes: Record<string, StubUser> = {},
  expiredPkceCodes: string[] = [],
) {
  return installStubAuthServer({
    mode: "normal",
    users: [USER_A, USER_B],
    pkceCodes,
    expiredPkceCodes,
  });
}

/** Starts a real magic-link flow so a real PKCE verifier is in the jar. */
async function startMagicLinkFlow() {
  await expect(requestMagicLink(SIGN_IN_EMAIL)).resolves.toBe("link_sent");
  expect(jar.has(verifierCookieName())).toBe(true);
}

/** Replaces `fetch` so only the PKCE exchange fails, leaving the rest intact. */
function failExchangeWith(fail: () => Promise<Response>) {
  const inner = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      if (
        url.pathname === "/auth/v1/token" &&
        url.searchParams.get("grant_type") === "pkce"
      ) {
        return fail();
      }
      return inner(input, init);
    },
  );
}

function spyOnLogger() {
  return [
    vi.spyOn(logger, "trace"),
    vi.spyOn(logger, "debug"),
    vi.spyOn(logger, "info"),
    vi.spyOn(logger, "warn"),
    vi.spyOn(logger, "error"),
    vi.spyOn(logger, "fatal"),
  ];
}

function loggedText(spies: ReturnType<typeof spyOnLogger>) {
  return JSON.stringify(spies.map((spy) => spy.mock.calls));
}

// --- tests -----------------------------------------------------------------

describe("callback completes a sign-in started in this browser", () => {
  it("redirects a magic-link code with its verifier to the dashboard and writes the session", async () => {
    const { requests } = installFlowServer({ [CODE_VICTIM]: USER_A });
    await startMagicLinkFlow();
    expect(sessionCookieEntries()).toEqual([]);

    const response = await GET(callbackRequest(`?code=${CODE_VICTIM}`));

    expectSignedInRedirect(response);
    expect(pkceRequests(requests)).toHaveLength(1);
    expect(sessionCookieEntries().length).toBeGreaterThan(0);
    expect(storedSession()).toMatchObject({
      access_token: USER_A.accessToken,
      refresh_token: USER_A.refreshToken,
    });
    await expect(requireSession()).resolves.toEqual({ userId: USER_A.id });
    // Single-use: the verifier does not survive the exchange.
    expect(jar.has(verifierCookieName())).toBe(false);
  });

  it("redirects a Google code with its verifier to the dashboard and writes the session", async () => {
    installFlowServer({ [CODE_VICTIM]: USER_A });
    await expect(startGoogleSignIn()).resolves.toMatchObject({
      status: "redirect",
    });
    expect(jar.has(verifierCookieName())).toBe(true);

    const response = await GET(callbackRequest(`?code=${CODE_VICTIM}`));

    expectSignedInRedirect(response);
    expect(storedSession()).toMatchObject({
      access_token: USER_A.accessToken,
    });
  });

  it("accepts a well-formed sb_flow_id and completes the flow it names", async () => {
    // auth-js keys each flow's verifier by a random id; the cookie name
    // carries it, so the id is recoverable without reaching into internals.
    const { requests } = installFlowServer({ [CODE_VICTIM]: USER_A });
    await startMagicLinkFlow();
    const slot = [...jar.keys()].find((name) =>
      /-flow-[0-9a-f]+-code-verifier$/.test(name),
    );
    const flowId = slot?.replace(/^.*-flow-([0-9a-f]+)-code-verifier$/, "$1");
    expect(flowId, `jar holds: ${[...jar.keys()].join(", ")}`).toBeDefined();

    const response = await GET(
      callbackRequest(`?code=${CODE_VICTIM}&sb_flow_id=${flowId ?? ""}`),
    );

    expectSignedInRedirect(response);
    expect(pkceRequests(requests)).toHaveLength(1);
    await expect(requireSession()).resolves.toEqual({ userId: USER_A.id });
  });
});

describe("callback rejects a code without the matching verifier (login CSRF) and a replayed code", () => {
  it("answers link_other_browser and establishes no session for a code that arrives with no verifier", async () => {
    // Login CSRF: the attacker completes a sign-in for their own account far
    // enough to obtain a valid auth code, then lures the victim's browser to
    // the callback carrying it. If it were accepted, the victim would be
    // silently signed in as the attacker and their later activity would land
    // in the attacker's account.
    //
    // The victim's browser holds no verifier for that flow, so auth-js raises
    // AuthPKCECodeVerifierMissingError without contacting the auth server —
    // asserted below as zero PKCE requests. What the stub cannot show: that
    // real GoTrue would also refuse the code if it were submitted, because
    // this stub never inspects the `code_verifier` it receives.
    const { requests } = installFlowServer({ [CODE_ATTACKER]: USER_B });
    expect(jar.size).toBe(0);

    const response = await GET(callbackRequest(`?code=${CODE_ATTACKER}`));

    expectSignInError(response, "link_other_browser");
    expect(pkceRequests(requests)).toHaveLength(0);
    expect(requests).toEqual([]);
    expectNoSession();
    const failure = await requireSession().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AuthenticationError);
    expect(failure).toMatchObject({ code: "session_missing" });
  });

  it("answers link_other_browser when the verifier cookie is dropped after the flow started", async () => {
    const { requests } = installFlowServer({ [CODE_VICTIM]: USER_A });
    await startMagicLinkFlow();
    // Another browser, or a cleared cookie jar: the code is genuine, the
    // verifier that binds it to this browser is not here.
    jar.clear();

    const response = await GET(callbackRequest(`?code=${CODE_VICTIM}`));

    expectSignInError(response, "link_other_browser");
    expect(pkceRequests(requests)).toHaveLength(0);
    expectNoSession();
  });

  it("answers link_other_browser when a code names a flow id this browser never started", async () => {
    const { requests } = installFlowServer({ [CODE_ATTACKER]: USER_B });
    await startMagicLinkFlow();

    const response = await GET(
      callbackRequest(
        `?code=${CODE_ATTACKER}&sb_flow_id=00112233445566778899aabbccddeeff`,
      ),
    );

    expectSignInError(response, "link_other_browser");
    expect(pkceRequests(requests)).toHaveLength(0);
    expectNoSession();
  });

  it("submits only the verifier this browser stored, so the auth server can bind the code to it", async () => {
    // The half of PKCE the stub cannot enforce. With a verifier present the
    // exchange does go out, and this stub answers on the auth code alone — so
    // the meaningful assertion is that the body carries exactly this browser's
    // verifier and nothing derived from the URL. Real GoTrue compares its
    // S256 against the challenge stored with the flow and rejects a mismatch.
    const { bodies } = installFlowServer({ [CODE_ATTACKER]: USER_B });
    await startMagicLinkFlow();
    const verifier = storedVerifier();

    await GET(callbackRequest(`?code=${CODE_ATTACKER}`));

    const exchanges = bodies.filter((entry) => entry.path === PKCE_PATH);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]?.body).toEqual({
      auth_code: CODE_ATTACKER,
      code_verifier: verifier,
    });
  });

  it("signs in once and answers link_invalid when the same code is replayed with a fresh verifier", async () => {
    const { requests } = installFlowServer({ [CODE_VICTIM]: USER_A });

    await startMagicLinkFlow();
    const first = await GET(callbackRequest(`?code=${CODE_VICTIM}`));
    expectSignedInRedirect(first);
    expect(storedSession()).toMatchObject({
      access_token: USER_A.accessToken,
    });

    // A fresh flow, so the replay fails on the code being spent rather than
    // on a missing verifier.
    await startMagicLinkFlow();
    const second = await GET(callbackRequest(`?code=${CODE_VICTIM}`));

    expectSignInError(second, "link_invalid");
    expect(pkceRequests(requests)).toHaveLength(2);
    // The first sign-in stands; the replay neither created nor replaced one.
    expect(storedSession()).toMatchObject({
      access_token: USER_A.accessToken,
      refresh_token: USER_A.refreshToken,
    });
  });

  it("does not replace an existing session with an attacker's replayed code", async () => {
    installFlowServer({ [CODE_VICTIM]: USER_A, [CODE_ATTACKER]: USER_B });
    await startMagicLinkFlow();
    expectSignedInRedirect(await GET(callbackRequest(`?code=${CODE_VICTIM}`)));

    // Attacker's code, victim's browser, no verifier for the attacker's flow.
    const response = await GET(callbackRequest(`?code=${CODE_ATTACKER}`));

    expectSignInError(response, "link_other_browser");
    expect(decodedJarText()).not.toContain(USER_B.accessToken);
    expect(decodedJarText()).not.toContain(USER_B.id);
    await expect(requireSession()).resolves.toEqual({ userId: USER_A.id });
  });

  it("answers link_expired for a code whose flow state has expired", async () => {
    const { requests } = installFlowServer({}, [CODE_EXPIRED]);
    await startMagicLinkFlow();

    const response = await GET(callbackRequest(`?code=${CODE_EXPIRED}`));

    expectSignInError(response, "link_expired");
    expect(pkceRequests(requests)).toHaveLength(1);
    expectNoSession();
  });
});

describe("callback error codes come from the allowlist, never from input", () => {
  const malformedQueries: [string, string][] = [
    ["no code parameter at all", ""],
    ["an empty query string", "?"],
    ["an empty code", "?code="],
    ["a code shorter than 16 characters", "?code=abc123"],
    ["a code longer than 512 characters", `?code=${"a".repeat(513)}`],
    [
      "a code with characters outside the allowed set",
      `?code=${encodeURIComponent("3f2b8c1d/9a4e+4b7f 8c2d")}`,
    ],
    [
      "a code containing CRLF",
      `?code=${encodeURIComponent("3f2b8c1d-9a4e-4b7f\r\nSet-Cookie: a=b")}`,
    ],
    [
      "a code that is a URL",
      `?code=${encodeURIComponent("https://evil.example/callback")}`,
    ],
    [
      "a code that is a path traversal",
      `?code=${encodeURIComponent("../../../etc/passwd")}`,
    ],
    [
      "a code containing a null byte",
      `?code=${encodeURIComponent("3f2b8c1d-9a4e-4b7f-8c2d-1e6a5b9f0c\u0000")}`,
    ],
    ["a code that is only a fragment marker", "?code=%23"],
    ["an empty sb_flow_id", `?code=${CODE_VICTIM}&sb_flow_id=`],
    [
      "an sb_flow_id with a path traversal",
      `?code=${CODE_VICTIM}&sb_flow_id=${encodeURIComponent("../../evil")}`,
    ],
    ["an sb_flow_id containing a dot", `?code=${CODE_VICTIM}&sb_flow_id=a.b`],
    [
      "an sb_flow_id longer than 128 characters",
      `?code=${CODE_VICTIM}&sb_flow_id=${"a".repeat(129)}`,
    ],
    [
      "an sb_flow_id with a script payload",
      `?code=${CODE_VICTIM}&sb_flow_id=${encodeURIComponent("<script>alert(1)</script>")}`,
    ],
  ];

  it.each(malformedQueries)(
    "answers link_invalid for %s and makes zero auth-server requests",
    async (_label, query) => {
      const { requests } = installFlowServer({ [CODE_VICTIM]: USER_A });

      const response = await GET(callbackRequest(query));

      expectSignInError(response, "link_invalid");
      expect(requests).toEqual([]);
      expectNoSession();
    },
  );

  it("rejects repeated code parameters without submitting either code to the auth server", async () => {
    // Parameter pollution: two codes is not "a validated code". Silently
    // picking one spends a single-use code chosen by whoever crafted the link,
    // and picks a winner an edge proxy, WAF or log pipeline in front of the
    // app may not agree with — the classic HPP split between what is inspected
    // and what is acted on. The contract is a validated code, so an ambiguous
    // callback URL must fail closed.
    const { requests, bodies } = installFlowServer({ [CODE_VICTIM]: USER_A });
    await startMagicLinkFlow();

    const response = await GET(
      callbackRequest(`?code=${CODE_VICTIM}&code=${CODE_ATTACKER}`),
    );

    expect(
      pkceRequests(requests),
      `an ambiguous callback URL carrying two codes must not be exchanged; submitted: ${JSON.stringify(
        bodies.filter((entry) => entry.path === PKCE_PATH),
      )}`,
    ).toHaveLength(0);
    expect(
      new URL(locationOf(response)).pathname,
      "a callback URL carrying two codes must not complete a sign-in",
    ).toBe("/sign-in");
    expectSignInError(response, "link_invalid");
    expectNoSession();
  });

  it("rejects repeated sb_flow_id parameters", async () => {
    const { requests } = installFlowServer({ [CODE_VICTIM]: USER_A });
    await startMagicLinkFlow();

    const response = await GET(
      callbackRequest(
        `?code=${CODE_VICTIM}&sb_flow_id=00112233445566778899aabbccddeeff&sb_flow_id=ffeeddccbbaa99887766554433221100`,
      ),
    );

    expect(pkceRequests(requests)).toHaveLength(0);
    expect(
      new URL(locationOf(response)).searchParams.get("error"),
      "two flow ids are ambiguous input and must be rejected as invalid, not resolved by taking the first",
    ).toBe("link_invalid");
    expectSignInError(response, "link_invalid");
    expectNoSession();
  });

  it("answers sign_in_failed for a provider error with a hostile description", async () => {
    const { requests } = installFlowServer({ [CODE_VICTIM]: USER_A });
    await startMagicLinkFlow();

    const response = await GET(
      callbackRequest(
        `?error=access_denied&error_code=${encodeURIComponent("provider_email_needs_verification")}` +
          `&error_description=${encodeURIComponent('Sign in at https://evil.example/ <img src=x onerror=alert(1)> "quoted"')}`,
      ),
    );

    expectSignInError(response, "sign_in_failed");
    expect(pkceRequests(requests)).toHaveLength(0);
    expectNoSession();
  });

  it("answers link_expired when the provider reports an expired magic link", async () => {
    // GoTrue redirects an expired link back with error_code=otp_expired and no
    // code at all, so the person is told to request a new link rather than
    // being shown a generic failure.
    const { requests } = installFlowServer({ [CODE_VICTIM]: USER_A });
    await startMagicLinkFlow();

    const response = await GET(
      callbackRequest(
        "?error=access_denied&error_code=otp_expired" +
          "&error_description=Email+link+is+invalid+or+has+expired",
      ),
    );

    expectSignInError(response, "link_expired");
    expect(pkceRequests(requests)).toHaveLength(0);
    expectNoSession();
  });

  it("answers sign_in_failed for a provider error even when a usable code is also present", async () => {
    // A provider that reports an error has not authorized anyone; a code
    // riding alongside it is not evidence of a successful sign-in.
    const { requests } = installFlowServer({ [CODE_ATTACKER]: USER_B });
    await startMagicLinkFlow();

    const response = await GET(
      callbackRequest(`?code=${CODE_ATTACKER}&error=access_denied`),
    );

    expectSignInError(response, "sign_in_failed");
    expect(pkceRequests(requests)).toHaveLength(0);
    expectNoSession();
  });

  it("never echoes hostile code, error, error_description, sb_flow_id or extra parameters into the Location", async () => {
    const hostile = [
      "evil.example",
      "javascript:",
      "<script>",
      "onerror",
      "Set-Cookie",
      "/dashboard",
      "returnTo",
      "redirect_to",
      "next=",
      "..%2f",
      "%0d%0a",
    ];
    const queries = [
      `?code=${encodeURIComponent("javascript:alert(1)")}` +
        `&sb_flow_id=${encodeURIComponent("../../evil.example")}` +
        `&next=${encodeURIComponent("https://evil.example/steal")}` +
        `&redirect_to=${encodeURIComponent("https://evil.example/steal")}` +
        `&returnTo=${encodeURIComponent("//evil.example")}`,
      `?error=${encodeURIComponent("<script>alert(1)</script>")}` +
        `&error_description=${encodeURIComponent("Location: https://evil.example/%0d%0aSet-Cookie: a=b")}` +
        `&error_uri=${encodeURIComponent("https://evil.example/doc")}`,
      `?code=${encodeURIComponent("3f2b8c1d-9a4e-4b7f-8c2d-1e6a5b9f0c33#@evil.example")}` +
        `&error=${encodeURIComponent("link_other_browser")}`,
      `?code=${encodeURIComponent("%0d%0aSet-Cookie: session=stolen")}`,
    ];

    for (const query of queries) {
      jar.clear();
      vi.unstubAllGlobals();
      installFlowServer({ [CODE_VICTIM]: USER_A });

      const response = await GET(callbackRequest(query));

      expectRedirect(response);
      const location = locationOf(response);
      const url = new URL(location);
      const code = url.searchParams.get("error") ?? "";
      expect([...CALLBACK_ERROR_CODES], query).toContain(code);
      // Exactly one parameter, and it is the allowlisted code.
      expect(Object.fromEntries(url.searchParams), query).toEqual({
        error: code,
      });
      expect(location, query).toBe(`${APP_URL}/sign-in?error=${code}`);

      const lowered = location.toLowerCase();
      for (const fragment of hostile) {
        expect(lowered, query).not.toContain(fragment.toLowerCase());
      }
      // Nothing echoed into any other response header either.
      for (const [name, value] of response.headers) {
        expect(value.toLowerCase(), `${query} -> ${name}`).not.toContain(
          "evil.example",
        );
      }
      expectNoSession();
    }
  });

  it("answers every failure with a code from the allowlist and never with auth-server text", async () => {
    const seen = new Set<string>();

    const scenarios: (() => Promise<Response>)[] = [
      async () => {
        installFlowServer();
        return GET(callbackRequest("?code=short"));
      },
      async () => {
        installFlowServer({ [CODE_ATTACKER]: USER_B });
        return GET(callbackRequest(`?code=${CODE_ATTACKER}`));
      },
      async () => {
        installFlowServer({}, [CODE_EXPIRED]);
        await startMagicLinkFlow();
        return GET(callbackRequest(`?code=${CODE_EXPIRED}`));
      },
      async () => {
        installFlowServer();
        await startMagicLinkFlow();
        return GET(callbackRequest(`?code=${CODE_SECOND}`));
      },
      async () => {
        installFlowServer();
        return GET(callbackRequest("?error=server_error"));
      },
      async () => {
        installFlowServer();
        await startMagicLinkFlow();
        failExchangeWith(
          async () =>
            new Response(
              JSON.stringify({ code: "unexpected_failure", msg: "stubbed" }),
              {
                status: 500,
                headers: {
                  "content-type": "application/json",
                  "x-supabase-api-version": "2024-01-01",
                },
              },
            ),
        );
        return GET(callbackRequest(`?code=${CODE_SECOND}`));
      },
    ];

    for (const scenario of scenarios) {
      jar.clear();
      vi.unstubAllGlobals();

      const response = await scenario();

      expectRedirect(response);
      const url = new URL(locationOf(response));
      const code = url.searchParams.get("error") ?? "";
      expect([...CALLBACK_ERROR_CODES]).toContain(code);
      expect(locationOf(response)).not.toContain("stubbed");
      expect(locationOf(response)).not.toContain("unexpected_failure");
      expect(locationOf(response)).not.toContain("flow_state");
      seen.add(code);
    }

    expect([...seen].sort()).toEqual([
      "link_expired",
      "link_invalid",
      "link_other_browser",
      "sign_in_failed",
      "sign_in_unavailable",
    ]);
  });
});

describe("callback maps auth-server outages to sign_in_unavailable", () => {
  it("answers sign_in_unavailable when the exchange returns 500", async () => {
    installFlowServer();
    await startMagicLinkFlow();
    failExchangeWith(
      async () =>
        new Response(
          JSON.stringify({ code: "unexpected_failure", msg: "stubbed" }),
          {
            status: 500,
            headers: {
              "content-type": "application/json",
              "x-supabase-api-version": "2024-01-01",
            },
          },
        ),
    );

    const response = await GET(callbackRequest(`?code=${CODE_VICTIM}`));

    expectSignInError(response, "sign_in_unavailable");
    expectNoSession();
  });

  it("answers sign_in_unavailable when the exchange cannot reach the auth server", async () => {
    installFlowServer();
    await startMagicLinkFlow();
    failExchangeWith(async () => {
      throw new TypeError("fetch failed");
    });

    const response = await GET(callbackRequest(`?code=${CODE_VICTIM}`));

    expectSignInError(response, "sign_in_unavailable");
    expectNoSession();
  });

  it("answers sign_in_unavailable when the exchange succeeds without a valid user id", async () => {
    installFlowServer();
    await startMagicLinkFlow();
    failExchangeWith(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "access-token-unknown-user",
            refresh_token: "refresh-token-unknown-user",
            token_type: "bearer",
            expires_in: 3600,
            expires_at: Math.floor(Date.now() / 1000) + 3600,
            user: { id: "not-a-uuid", aud: "authenticated" },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "x-supabase-api-version": "2024-01-01",
            },
          },
        ),
    );

    const response = await GET(callbackRequest(`?code=${CODE_VICTIM}`));

    expectSignInError(response, "sign_in_unavailable");
  });
});

describe("callback ignores a spoofed Host and X-Forwarded-Host", () => {
  const spoofed = {
    host: "evil.example",
    "x-forwarded-host": "evil.example",
    "x-forwarded-proto": "https",
    "x-forwarded-port": "8443",
    forwarded: "host=evil.example;proto=https",
  };

  it("sends a successful sign-in to the configured origin", async () => {
    installFlowServer({ [CODE_VICTIM]: USER_A });
    await startMagicLinkFlow();

    const response = await GET(
      callbackRequest(`?code=${CODE_VICTIM}`, spoofed),
    );

    expectSignedInRedirect(response);
    expect(locationOf(response)).not.toContain("evil.example");
  });

  it("sends a failure to the configured origin", async () => {
    installFlowServer();

    const response = await GET(callbackRequest("?code=nope", spoofed));

    expectSignInError(response, "link_invalid");
    expect(locationOf(response)).not.toContain("evil.example");
  });

  it("ignores a spoofed host in the request URL itself", async () => {
    installFlowServer({ [CODE_VICTIM]: USER_A });
    await startMagicLinkFlow();

    const response = await GET(
      new NextRequest(
        `https://evil.example/auth/callback?code=${CODE_VICTIM}`,
        { headers: spoofed },
      ),
    );

    expectRedirect(response);
    expect(new URL(locationOf(response)).origin).toBe(APP_URL);
    expect(locationOf(response)).not.toContain("evil.example");
  });
});

describe("callback logging", () => {
  it("never logs the auth code, the verifier, a token, or the address", async () => {
    installFlowServer({ [CODE_VICTIM]: USER_A }, [CODE_EXPIRED]);
    const spies = spyOnLogger();

    await startMagicLinkFlow();
    const verifier = storedVerifier();

    await GET(callbackRequest(`?code=${CODE_EXPIRED}`));
    await GET(callbackRequest(`?code=${CODE_ATTACKER}`));
    await GET(callbackRequest("?code=%20%20"));
    await GET(callbackRequest("?error=access_denied&error_description=oops"));
    await startMagicLinkFlow();
    const secondVerifier = storedVerifier();
    await GET(callbackRequest(`?code=${CODE_VICTIM}`));

    const logs = loggedText(spies);
    for (const secret of [
      CODE_VICTIM,
      CODE_ATTACKER,
      CODE_EXPIRED,
      verifier,
      secondVerifier,
      USER_A.accessToken,
      USER_A.refreshToken,
      USER_B.accessToken,
      SIGN_IN_EMAIL,
      "zq.callback-person",
      sessionCookieName(),
    ]) {
      expect(logs, `leaked: ${secret}`).not.toContain(secret);
    }
    expect(logs).not.toContain("code_verifier");
  });

  it("logs a failure event carrying only the result code and error identifiers", async () => {
    installFlowServer({}, [CODE_EXPIRED]);
    const warn = vi.spyOn(logger, "warn");
    await startMagicLinkFlow();

    await GET(callbackRequest(`?code=${CODE_EXPIRED}`));

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "sign_in_callback_failed",
        code: "link_expired",
      }),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(CODE_EXPIRED);
  });
});

describe("callback route surface", () => {
  it("exports GET only", () => {
    const exports: Record<string, unknown> = { ...callbackRoute };

    expect(typeof exports.GET).toBe("function");
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      expect(exports[method], method).toBeUndefined();
    }
    expect(Object.keys(exports)).toEqual(["GET"]);
  });

  it("takes only the request, so no identity can be passed in", () => {
    expect(GET.length).toBe(1);
  });
});
