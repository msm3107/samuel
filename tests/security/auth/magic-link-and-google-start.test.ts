import { createHash } from "node:crypto";

import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * A cookie jar that behaves like a route handler's or server action's
 * `next/headers` store: writes are applied, so the PKCE verifier written when
 * a flow starts can be inspected.
 *
 * `headers()` answers with a spoofed Host and X-Forwarded-Host. None of the
 * functions under test should read it; if one did and built a URL from it, the
 * redirect assertions below would see `evil.example`.
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

import {
  requestMagicLinkAction,
  startGoogleSignInAction,
} from "@/lib/auth/sign-in/actions";
import { requestMagicLink } from "@/lib/auth/sign-in/request-magic-link";
import { startGoogleSignIn } from "@/lib/auth/sign-in/start-google-sign-in";
import { serverEnv } from "@/lib/env/server-env";
import { logger } from "@/lib/logging/logger";

import {
  installStubAuthServer,
  sessionCookieName,
  USER_A,
} from "./support/stub-auth-server";

const EXPECTED_CALLBACK = new URL(
  "/auth/callback",
  serverEnv().NEXT_PUBLIC_APP_URL,
).toString();

const OTP_PATH = "/auth/v1/otp";

/** Distinctive enough that a substring match in log output is meaningful. */
const RAW_EMAIL = "  Zq.Private-Person@Example.COM ";
const NORMALIZED_EMAIL = "zq.private-person@example.com";

afterEach(() => {
  vi.unstubAllGlobals();
  jar.clear();
});

function verifierCookieName() {
  return `${sessionCookieName()}-code-verifier`;
}

function spyOnLogger() {
  return [
    vi.spyOn(logger, "warn"),
    vi.spyOn(logger, "error"),
    vi.spyOn(logger, "info"),
    vi.spyOn(logger, "debug"),
    vi.spyOn(logger, "fatal"),
    vi.spyOn(logger, "trace"),
  ];
}

function loggedText(spies: ReturnType<typeof spyOnLogger>) {
  return JSON.stringify(spies.map((spy) => spy.mock.calls));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function otpBody(bodies: { path: string; body: unknown }[]) {
  const otp = bodies.filter((entry) => entry.path.startsWith(OTP_PATH));
  expect(otp).toHaveLength(1);
  const [entry] = otp;
  if (!entry || !isRecord(entry.body)) {
    throw new Error("expected a JSON object body on the OTP request");
  }
  return entry.body;
}

/**
 * Decodes a cookie written by `@supabase/ssr` (`base64-` + base64url JSON, or
 * a raw JSON value) into the string auth-js stored.
 */
function decodeStoredString(cookieValue: string): string {
  const json = cookieValue.startsWith("base64-")
    ? Buffer.from(cookieValue.slice("base64-".length), "base64url").toString(
        "utf8",
      )
    : cookieValue;
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "string") {
    throw new Error("expected the stored verifier to be a string");
  }
  return parsed;
}

function s256(verifier: string) {
  return createHash("sha256").update(verifier).digest("base64url");
}

function redirectDigest(error: unknown): string {
  if (
    error instanceof Error &&
    "digest" in error &&
    typeof error.digest === "string"
  ) {
    return error.digest;
  }
  throw new Error("expected a Next.js redirect error with a digest");
}

describe("requestMagicLink", () => {
  it("sends a PKCE magic link that creates the account and returns to the configured callback", async () => {
    const { requests, bodies } = installStubAuthServer({
      mode: "normal",
      users: [],
    });

    await expect(requestMagicLink(RAW_EMAIL)).resolves.toBe("link_sent");

    expect(requests).toHaveLength(1);
    const [request] = requests;
    expect(request?.method).toBe("POST");
    const url = new URL(request?.path ?? "", "http://stub.invalid");
    expect(url.pathname).toBe(OTP_PATH);
    expect(url.searchParams.get("redirect_to")).toBe(EXPECTED_CALLBACK);
    expect(EXPECTED_CALLBACK).toBe("http://localhost:3000/auth/callback");

    const body = otpBody(bodies);
    expect(body.create_user).toBe(true);
    expect(body.email).toBe(NORMALIZED_EMAIL);
    expect(typeof body.code_challenge).toBe("string");
    expect(String(body.code_challenge).length).toBeGreaterThanOrEqual(43);
    expect(String(body.code_challenge_method).toLowerCase()).toBe("s256");
  });

  it("stores a verifier cookie whose S256 hash is the code challenge sent to the auth server", async () => {
    const { bodies } = installStubAuthServer({ mode: "normal", users: [] });

    await expect(requestMagicLink(NORMALIZED_EMAIL)).resolves.toBe("link_sent");

    const stored = jar.get(verifierCookieName());
    expect(stored, `jar holds: ${[...jar.keys()].join(", ")}`).toBeDefined();
    const verifier = decodeStoredString(stored ?? "");
    expect(s256(verifier)).toBe(otpBody(bodies).code_challenge);
  });

  describe("security: registered and unregistered addresses produce identical results", () => {
    // The stub auth server cannot tell a registered address from an
    // unregistered one, so this proves only that the function itself treats
    // them identically: same result, same request shape, same cookies, same
    // logs. It does not prove GoTrue's own responses are indistinguishable.
    async function observe(email: string) {
      jar.clear();
      vi.unstubAllGlobals();
      const { requests, bodies } = installStubAuthServer({
        mode: "normal",
        users: [USER_A],
      });
      const spies = spyOnLogger();

      const result = await requestMagicLink(email);

      const body = otpBody(bodies);
      const normalizedBody: Record<string, unknown> = {
        ...body,
        email: "<email>",
        code_challenge: "<challenge>",
      };
      const observation = {
        result,
        requests: requests.map(({ method, path, authorization }) => ({
          method,
          path,
          authorization,
        })),
        body: normalizedBody,
        // auth-js keys each PKCE flow's verifier cookie by a random flow id,
        // so the ids differ between two runs by design.
        cookieNames: [...jar.keys()]
          .map((name) => name.replace(/-flow-[0-9a-f]+-/, "-flow-<id>-"))
          .sort(),
        logs: loggedText(spies),
        sentEmail: body.email,
      };
      for (const spy of spies) {
        spy.mockRestore();
      }
      return observation;
    }

    it("returns link_sent and sends the same request for a registered and an unregistered address", async () => {
      const registeredEmail = `${USER_A.id}@example.test`;
      const unregisteredEmail = "nobody-has-this-address@example.test";

      const registered = await observe(registeredEmail);
      const unregistered = await observe(unregisteredEmail);

      expect(registered.result).toBe("link_sent");
      expect(unregistered.result).toBe("link_sent");
      expect(registered.sentEmail).toBe(registeredEmail);
      expect(unregistered.sentEmail).toBe(unregisteredEmail);

      const { sentEmail: _registeredEmail, ...registeredShape } = registered;
      const { sentEmail: _unregisteredEmail, ...unregisteredShape } =
        unregistered;
      expect(registeredShape).toEqual(unregisteredShape);
    });

    it("gives no registration-dependent parameter to the auth server: every address asks to create the user", async () => {
      const registered = await observe(`${USER_A.id}@example.test`);
      const unregistered = await observe("fresh-address@example.test");

      expect(registered.body.create_user).toBe(true);
      expect(unregistered.body.create_user).toBe(true);
    });
  });

  describe("rejects invalid input without contacting the auth server", () => {
    const invalidInputs: [string, unknown][] = [
      ["an empty string", ""],
      ["whitespace", "   "],
      ["a string without an at sign", "not-an-email"],
      ["a missing domain", "person@"],
      ["a missing local part", "@example.com"],
      ["two addresses", "a@example.com,b@example.com"],
      ["an embedded header injection", "a@example.com\r\nBcc: b@example.com"],
      [
        "an address longer than 254 characters",
        `${"a".repeat(245)}@example.com`,
      ],
      ["a number", 42],
      ["null", null],
      ["undefined", undefined],
      ["an object", { email: "person@example.com" }],
      ["an array", ["person@example.com"]],
    ];

    it.each(invalidInputs)(
      "returns invalid_email for %s and makes zero requests",
      async (_label, input) => {
        const { requests } = installStubAuthServer({
          mode: "normal",
          users: [],
        });

        await expect(requestMagicLink(input)).resolves.toBe("invalid_email");
        expect(requests).toHaveLength(0);
        expect(jar.has(verifierCookieName())).toBe(false);
      },
    );
  });

  describe("maps auth server failures to fixed result codes", () => {
    const cases: [
      string,
      Parameters<typeof installStubAuthServer>[0],
      "link_sent" | "invalid_email" | "unavailable",
    ][] = [
      [
        "429 over_email_send_rate_limit (a link was already sent)",
        {
          mode: "normal",
          users: [],
          otp: { status: 429, code: "over_email_send_rate_limit" },
        },
        "link_sent",
      ],
      [
        "400 email_address_invalid",
        {
          mode: "normal",
          users: [],
          otp: { status: 400, code: "email_address_invalid" },
        },
        "invalid_email",
      ],
      [
        "429 over_request_rate_limit",
        {
          mode: "normal",
          users: [],
          otp: { status: 429, code: "over_request_rate_limit" },
        },
        "unavailable",
      ],
      [
        "500",
        { mode: "normal", users: [], otp: { status: 500 } },
        "unavailable",
      ],
      ["a network failure", { mode: "network-failure" }, "unavailable"],
      [
        // Only an unregistered address can produce this, so answering anything
        // other than the usual confirmation would reveal that no account
        // exists. The operator sees it in the logs instead.
        "422 signup_disabled",
        {
          mode: "normal",
          users: [],
          otp: { status: 422, code: "signup_disabled" },
        },
        "link_sent",
      ],
    ];

    it.each(cases)(
      "answers %s with the expected code and never logs the address",
      async (_label, behaviour, expected) => {
        const { requests } = installStubAuthServer(behaviour);
        const spies = spyOnLogger();

        await expect(requestMagicLink(RAW_EMAIL)).resolves.toBe(expected);

        expect(
          requests.filter((request) => request.path.startsWith(OTP_PATH)),
        ).toHaveLength(1);
        const logs = loggedText(spies).toLowerCase();
        expect(logs).not.toContain(NORMALIZED_EMAIL);
        expect(logs).not.toContain("zq.private-person");
        expect(logs).not.toContain("stubbed");
      },
    );
  });

  it("never logs the address on success or on invalid input", async () => {
    installStubAuthServer({ mode: "normal", users: [] });
    const spies = spyOnLogger();

    await requestMagicLink(RAW_EMAIL);
    await requestMagicLink("zq.private-person@");

    const logs = loggedText(spies).toLowerCase();
    expect(logs).not.toContain("zq.private-person");
  });
});

describe("startGoogleSignIn", () => {
  it("returns a Supabase authorize URL for Google with the configured callback and a code challenge, without a network call", async () => {
    const { requests } = installStubAuthServer({ mode: "normal", users: [] });

    const result = await startGoogleSignIn();

    expect(result.status).toBe("redirect");
    if (result.status !== "redirect") {
      return;
    }
    const url = new URL(result.url);
    expect(url.origin).toBe(new URL(serverEnv().SUPABASE_URL).origin);
    expect(url.pathname).toBe("/auth/v1/authorize");
    expect(url.searchParams.get("provider")).toBe("google");
    expect(url.searchParams.get("redirect_to")).toBe(EXPECTED_CALLBACK);
    const challenge = url.searchParams.get("code_challenge");
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    expect(url.searchParams.get("code_challenge_method")?.toLowerCase()).toBe(
      "s256",
    );

    expect(requests).toHaveLength(0);

    const stored = jar.get(verifierCookieName());
    expect(stored, `jar holds: ${[...jar.keys()].join(", ")}`).toBeDefined();
    expect(s256(decodeStoredString(stored ?? ""))).toBe(challenge);
  });
});

describe("security: redirect URLs ignore a spoofed Host header", () => {
  // What this proves: neither function accepts a request (arity), so a caller
  // cannot hand one in; and even with `next/headers` `headers()` reporting a
  // spoofed Host / X-Forwarded-Host (see the mock above) and a spoofed
  // NextRequest in scope, the URLs sent to Supabase are built from
  // NEXT_PUBLIC_APP_URL. What it does not prove: behaviour under a real Next.js
  // request context, or that no other ambient source (e.g. a global) is read.
  const spoofed = new NextRequest("http://evil.example/sign-in", {
    headers: { host: "evil.example", "x-forwarded-host": "evil.example" },
  });

  it("takes no request parameter", () => {
    expect(requestMagicLink.length).toBe(1);
    expect(startGoogleSignIn.length).toBe(0);
    expect(requestMagicLinkAction.length).toBe(2);
    expect(startGoogleSignInAction.length).toBe(0);
  });

  it("sends the configured callback as the magic link redirect", async () => {
    const { requests } = installStubAuthServer({ mode: "normal", users: [] });
    expect(spoofed.headers.get("host")).toBe("evil.example");

    await expect(requestMagicLink(NORMALIZED_EMAIL)).resolves.toBe("link_sent");

    const [request] = requests;
    const url = new URL(request?.path ?? "", "http://stub.invalid");
    expect(url.searchParams.get("redirect_to")).toBe(EXPECTED_CALLBACK);
    expect(JSON.stringify(requests)).not.toContain("evil.example");
  });

  it("sends the configured callback as the Google redirect", async () => {
    installStubAuthServer({ mode: "normal", users: [] });
    expect(spoofed.headers.get("x-forwarded-host")).toBe("evil.example");

    const result = await startGoogleSignIn();

    expect(result.status).toBe("redirect");
    if (result.status !== "redirect") {
      return;
    }
    expect(new URL(result.url).searchParams.get("redirect_to")).toBe(
      EXPECTED_CALLBACK,
    );
    expect(result.url).not.toContain("evil.example");
  });
});

describe("server actions", () => {
  it("returns link_sent for a valid email field", async () => {
    const { requests } = installStubAuthServer({ mode: "normal", users: [] });
    const formData = new FormData();
    formData.set("email", RAW_EMAIL);

    await expect(requestMagicLinkAction(null, formData)).resolves.toEqual({
      result: "link_sent",
    });
    expect(
      requests.filter((request) => request.path.startsWith(OTP_PATH)),
    ).toHaveLength(1);
  });

  it("returns invalid_email when the email field is missing", async () => {
    const { requests } = installStubAuthServer({ mode: "normal", users: [] });

    await expect(requestMagicLinkAction(null, new FormData())).resolves.toEqual(
      { result: "invalid_email" },
    );
    expect(requests).toHaveLength(0);
  });

  it.each([
    ["a string", "attacker@example.test"],
    ["a plain object", { email: "attacker@example.test" }],
    ["null", null],
  ])(
    "returns invalid_email when a caller passes %s instead of form data",
    async (_label, argument) => {
      // A server action's arguments come from the browser, so it must not
      // assume the shape its type promises. Reflect.apply reaches past the
      // declared parameter type without a banned cast.
      const { requests } = installStubAuthServer({ mode: "normal", users: [] });

      await expect(
        Reflect.apply(requestMagicLinkAction, undefined, [null, argument]),
      ).resolves.toEqual({ result: "invalid_email" });
      expect(requests).toHaveLength(0);
    },
  );

  it("returns invalid_email when the email field is a file", async () => {
    const { requests } = installStubAuthServer({ mode: "normal", users: [] });
    const formData = new FormData();
    formData.set(
      "email",
      new File([NORMALIZED_EMAIL], "email.txt", { type: "text/plain" }),
    );

    await expect(requestMagicLinkAction(null, formData)).resolves.toEqual({
      result: "invalid_email",
    });
    expect(requests).toHaveLength(0);
  });

  it("redirects the Google action to the Supabase authorize URL", async () => {
    installStubAuthServer({ mode: "normal", users: [] });

    const error = await startGoogleSignInAction().then(
      () => {
        throw new Error("expected startGoogleSignInAction to redirect");
      },
      (thrown: unknown) => thrown,
    );

    const digest = redirectDigest(error);
    expect(digest.startsWith("NEXT_REDIRECT")).toBe(true);
    const target = digest
      .split(";")
      .find((part) => part.startsWith(serverEnv().SUPABASE_URL));
    expect(target, digest).toBeDefined();
    const url = new URL(target ?? "");
    expect(url.origin).toBe(new URL(serverEnv().SUPABASE_URL).origin);
    expect(url.pathname).toBe("/auth/v1/authorize");
    expect(url.searchParams.get("provider")).toBe("google");
    expect(url.searchParams.get("redirect_to")).toBe(EXPECTED_CALLBACK);
  });
});
